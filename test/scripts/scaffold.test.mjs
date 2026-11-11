// @worca/create-platform writes a deployment, and the
// deployment's commands (packages/platform/cli) generate its wrangler configs and set it up against
// a recording fake wrangler (fixtures/fake-wrangler.mjs). No Cloudflare account involved.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const CREATE = join(root, 'packages/create-platform/bin/create-platform.mjs');
const PLATFORM = join(root, 'packages/platform');
const CLI = join(PLATFORM, 'cli/main.mjs');
const FAKE = join(root, 'test/scripts/fixtures/fake-wrangler.mjs');
const ANSWERS = ['--instance-domain', 'example-instances.net', '--app-origin', 'https://app.example.com', '--account-id', '0123456789abcdef0123456789abcdef', '--zone-id', 'fedcba9876543210fedcba9876543210', '--railway-workspace', 'ws-123'];
const CREDS = { RAILWAY_TOKEN: 'rw-token', CF_API_TOKEN: 'cf-token', RESEND_API_KEY: 're_test' };

before(() => {
  // The CLI loads config helpers from dist/. `npm run test:scripts` builds it once before node --test
  // starts: building here would wipe dist/ while other test files (run in parallel) import from it.
  assert.ok(existsSync(join(PLATFORM, 'dist/index.js')), 'dist/ missing: run `npm run test:scripts`, which builds it first');
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const create = (cwd, args, env = {}) => spawnSync(process.execPath, [CREATE, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1', ...env } });

/** A scaffolded deployment with @worca/platform linked to this repo's package (no npm install). */
function deployment(t, extra = []) {
  const parent = scratch(t);
  const r = create(parent, ['site', '--yes', '--no-install', ...ANSWERS, ...extra]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const dir = join(parent, 'site');
  mkdirSync(join(dir, 'node_modules/@worca'), { recursive: true });
  symlinkSync(PLATFORM, join(dir, 'node_modules/@worca/platform'));
  return dir;
}

const cli = (dir, args, { state, env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', WORCA_WRANGLER: FAKE, FAKE_WRANGLER_STATE: state ?? join(dir, '.fake-wrangler.json'), ...env },
  });
const jsonc = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));

test('create-platform writes a deployment from flags', (t) => {
  const dir = deployment(t, ['--features', 'newsletter,tiers']);
  for (const f of ['package.json', 'worca.config.ts', 'src/control.ts', 'src/gate.ts', 'tsconfig.json', '.gitignore', 'README.md', 'worca.resources.json']) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  const cfg = readFileSync(join(dir, 'worca.config.ts'), 'utf8');
  assert.match(cfg, /name: 'site'/);
  assert.match(cfg, /appOrigin: 'https:\/\/app\.example\.com'/);
  assert.match(cfg, /features: \{ newsletter: true, accessRequests: false, tiers: true \}/);
  assert.match(cfg, /from: 'Worca <no-reply@example\.com>'/);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.setup, 'worca-platform setup');
  assert.match(pkg.dependencies['@worca/platform'], /^\^/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'worca.resources.json'), 'utf8')), {
    cloudflare: { accountId: '0123456789abcdef0123456789abcdef', zoneId: 'fedcba9876543210fedcba9876543210' },
    compute: { railwayWorkspaceId: 'ws-123' },
    environments: {},
  });
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.secrets\*\.env$/m);
});

test('create-platform reads answers from the environment', (t) => {
  const parent = scratch(t);
  const r = create(parent, ['envsite', '--yes', '--no-install'], { WORCA_INSTANCE_DOMAIN: 'inst.example.org', WORCA_APP_ORIGIN: 'https://console.example.com', WORCA_COMPUTE: 'fake' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readFileSync(join(parent, 'envsite/worca.config.ts'), 'utf8');
  assert.match(cfg, /instanceDomain: 'inst\.example\.org'/);
  assert.match(cfg, /compute: 'fake'/);
});

test('create-platform refuses what it must not touch', (t) => {
  const parent = scratch(t);
  mkdirSync(join(parent, 'full'));
  writeFileSync(join(parent, 'full/notes.txt'), 'mine');
  let r = create(parent, ['full', '--yes', '--no-install', ...ANSWERS]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't empty and isn't a deployment/);
  assert.equal(readFileSync(join(parent, 'full/notes.txt'), 'utf8'), 'mine');

  r = create(root, [join(root, 'tmp-deploy'), '--yes', '--no-install', ...ANSWERS]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside a checkout of the platform repository/);
  assert.equal(existsSync(join(root, 'tmp-deploy')), false);

  r = create(parent, ['bad', '--yes', '--no-install', '--instance-domain', 'example.net']);
  assert.match(r.stderr, /missing --app-origin/);
  r = create(parent, ['bad', '--yes', '--no-install', '--instance-domain', 'example.net', '--app-origin', 'https://app.example.net']);
  assert.match(r.stderr, /must not be on the instance domain/);
});

test('create-platform repairs an existing deployment: only missing files', (t) => {
  const dir = deployment(t);
  writeFileSync(join(dir, 'worca.config.ts'), readFileSync(join(dir, 'worca.config.ts'), 'utf8').replace("mail: { from: 'Worca <no-reply@example.com>' }", "mail: { from: 'Edited <x@example.com>' }"));
  unlinkSync(join(dir, 'src/gate.ts'));
  let r = create(join(dir, '..'), ['site', '--yes', '--no-install']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /existing deployment: pass --repair/);
  r = create(join(dir, '..'), ['site', '--yes', '--no-install', '--repair']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repaired: wrote src\/gate\.ts$/m);
  assert.ok(existsSync(join(dir, 'src/gate.ts')));
  assert.match(readFileSync(join(dir, 'worca.config.ts'), 'utf8'), /Edited <x@example\.com>/, 'existing files are kept');
});

test('configure: wrangler configs from worca.config.ts', (t) => {
  const dir = deployment(t);
  let r = cli(dir, ['configure']);
  assert.equal(r.status, 0, r.stderr);
  let control = jsonc(join(dir, 'wrangler.control.jsonc'));
  const gate = jsonc(join(dir, 'wrangler.gate.jsonc'));
  assert.equal(control.account_id, '0123456789abcdef0123456789abcdef');
  assert.deepEqual(Object.keys(control.env), ['prod', 'dev']);
  assert.equal(control.env.prod.name, 'site-control-prod');
  assert.deepEqual(control.env.prod.routes, [{ pattern: 'app.example.com', custom_domain: true }]);
  assert.equal(control.env.dev.routes, undefined, 'a local environment has no routes');
  assert.deepEqual(gate.env.prod.routes.map((x) => x.pattern), ['*.example-instances.net/*', 'example-instances.net', 'www.example-instances.net']);
  assert.equal(control.env.prod.d1_databases[0].database_id, 'run-npm-run-setup', 'no id before setup');
  assert.equal(control.env.prod.d1_databases[0].migrations_dir, 'node_modules/@worca/platform/migrations');
  assert.equal(control.assets.directory, 'node_modules/@worca/platform/ui');
  assert.deepEqual(control.env.prod.workflows.map((w) => w.binding), ['INSTANCE_OPS', 'KEY_ROTATION'], 'no newsletter Workflow while the module is off');
  assert.equal(control.env.prod.vars.COMPUTE_PROVIDER, 'railway');
  assert.equal(control.env.dev.vars.COMPUTE_PROVIDER, 'fake');
  assert.deepEqual(gate.migrations, [{ tag: 'v1', new_sqlite_classes: ['GateObject'] }]);

  writeFileSync(join(dir, 'worca.config.ts'), readFileSync(join(dir, 'worca.config.ts'), 'utf8').replace('newsletter: false', 'newsletter: true'));
  mkdirSync(join(dir, 'branding'));
  r = cli(dir, ['configure']);
  assert.equal(r.status, 0, r.stderr);
  control = jsonc(join(dir, 'wrangler.control.jsonc'));
  assert.deepEqual(control.env.prod.workflows.map((w) => w.class_name), ['InstanceOpsWorkflow', 'KeyRotationWorkflow', 'NewsletterSendWorkflow']);
  assert.equal(control.env.prod.vars.FEATURES, 'newsletter');
  assert.equal(control.assets.directory, '.assets', 'branding/ switches the console to the overlay');
});

test('setup: creates, generates and deploys once; a second run changes nothing', (t) => {
  const dir = deployment(t);
  const state = join(dir, '.fake-wrangler.json');
  let r = cli(dir, ['setup'], { state, env: CREDS });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let s = JSON.parse(readFileSync(state, 'utf8'));
  const calls = s.calls.map((c) => c.args.slice(0, 3).join(' '));
  assert.deepEqual(s.d1.map((d) => d.name), ['site-db-prod']);
  assert.deepEqual(s.kv.map((k) => k.title), ['site-control-kv-prod', 'site-hosts-prod']);
  const resources = JSON.parse(readFileSync(join(dir, 'worca.resources.json'), 'utf8'));
  assert.deepEqual(resources.environments.prod, { databaseId: s.d1[0].uuid, controlKvId: s.kv[0].id, hostsKvId: s.kv[1].id });
  const control = jsonc(join(dir, 'wrangler.control.jsonc'));
  assert.equal(control.env.prod.d1_databases[0].database_id, s.d1[0].uuid, 'ids written into the wrangler config');

  const file = join(dir, '.secrets.env');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 2, -1)]));
  for (const k of ['BETTER_AUTH_SECRET', 'MASTER_KEY', 'BLIND_INDEX_KEY', 'IDENTITY_SIGNING_JWK', 'SETUP_TOKEN', 'GATE_COOKIE_KEY', 'RAILWAY_TOKEN', 'CF_API_TOKEN', 'RESEND_API_KEY']) assert.ok(stored[k], k);
  assert.equal(stored.CF_ACCOUNT_ID, '0123456789abcdef0123456789abcdef', 'ids that are read as secrets come from worca.resources.json');
  assert.equal(stored.RAILWAY_WORKSPACE_ID, 'ws-123');
  assert.deepEqual(Object.keys(s.workers['site-gate-prod'].secrets), ['GATE_COOKIE_KEY']);
  assert.deepEqual(Object.keys(s.workers['site-control-prod'].secrets).sort(), [
    'BETTER_AUTH_SECRET', 'BLIND_INDEX_KEY', 'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ZONE_ID', 'IDENTITY_SIGNING_JWK', 'MASTER_KEY', 'RAILWAY_TOKEN', 'RAILWAY_WORKSPACE_ID', 'RESEND_API_KEY', 'SETUP_TOKEN',
  ]);
  assert.equal(s.workers['site-control-prod'].secrets.MASTER_KEY, stored.MASTER_KEY, 'the Worker has what .secrets.env holds');
  assert.ok(!JSON.stringify(s.calls).includes(stored.MASTER_KEY), 'secret values never appear as arguments');
  // Migrations before the final deploys; the gate before the control plane.
  const migrate = calls.lastIndexOf('d1 migrations apply');
  const deploys = s.calls.map((c, i) => [i, c.args]).filter(([, a]) => a[0] === 'deploy' && !a.includes('--dry-run'));
  const last = deploys.slice(-2).map(([i, a]) => [i, a[2]]);
  assert.deepEqual(last.map(([, c]) => c), ['wrangler.gate.jsonc', 'wrangler.control.jsonc']);
  assert.ok(migrate >= 0 && migrate < last[0][0]);
  // Each Worker deployed once to receive its secrets (it didn't exist), then once at the end.
  assert.equal(s.workers['site-gate-prod'].deploys, 2);
  assert.equal(s.workers['site-control-prod'].deploys, 2);
  assert.match(r.stdout, /MASTER_KEY encrypts tenant data/);
  assert.match(r.stdout, /npm run admin -- you@example\.com/);
  assert.match(r.stdout, /Public Suffix List/);

  const before = readFileSync(file, 'utf8');
  const callCount = s.calls.length;
  r = cli(dir, ['setup'], { state });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  s = JSON.parse(readFileSync(state, 'utf8'));
  const again = s.calls.slice(callCount).map((c) => c.args.slice(0, 3).join(' '));
  assert.equal(again.filter((c) => / create/.test(c)).length, 0, `second run creates nothing: ${again.join(' | ')}`);
  assert.equal(again.filter((c) => c.startsWith('secret bulk')).length, 0, 'second run uploads no secrets');
  assert.equal(readFileSync(file, 'utf8'), before, '.secrets.env unchanged: nothing regenerated');
  assert.match(r.stdout, /nothing to upload/);
  assert.equal(s.d1.length, 1);
  assert.equal(s.kv.length, 2);
});

test('setup asks for nothing it can find: missing credentials are listed, not fatal', (t) => {
  const dir = deployment(t);
  const r = cli(dir, ['setup'], { env: { RAILWAY_TOKEN: '', CF_API_TOKEN: '', RESEND_API_KEY: '' } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Not set yet \(npm run secrets -- set NAME\):\n\s+RAILWAY_TOKEN/);
  const s = JSON.parse(readFileSync(join(dir, '.fake-wrangler.json'), 'utf8'));
  assert.equal(s.workers['site-control-prod'].secrets.RAILWAY_TOKEN, undefined);
});

test('setup refuses a local environment, and wrangler that is not logged in', (t) => {
  const dir = deployment(t);
  let r = cli(dir, ['setup', '--env', 'dev']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no remote environment "dev"/);
  const bin = join(dir, 'nologin.mjs');
  writeFileSync(bin, "console.log('You are not authenticated. Please run `wrangler login`.'); process.exit(1);\n");
  r = cli(dir, ['setup'], { env: { WORCA_WRANGLER: bin } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not logged in/);
});

test('the prompt helper is the same in both packages', () => {
  const body = (f) => readFileSync(join(root, f), 'utf8').split('\n').slice(2).join('\n');
  assert.equal(body('packages/create-platform/lib/prompt.mjs'), body('packages/platform/cli/prompt.mjs'));
});

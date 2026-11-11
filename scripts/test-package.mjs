// npm run test:package: does a deployment work when both packages come from npm? Packs
// @worca/platform and @worca/create-platform, then, in a throwaway folder:
//   1. runs the packed create-platform non-interactively (npm install, configure)
//   2. npm run setup against a recording fake wrangler (no Cloudflare account): resources, secrets,
//      migrations, deploys; then again, which must change nothing
//   3. tsc on the deployment (types from dist/*.d.ts)
//   4. npm run deploy -- --dry-run with the real wrangler: both bundles export the classes
//      Cloudflare binds by name
//   5. npm run dev (local stack, fake providers): console, assets, sign-in page, the gate
//   6. npm run smoke -- --env dev: an instance created, reached through the gate, deleted
//
// Env: TEST_PACKAGE_DIR   parent folder for the throwaway deployment (default: the OS temp dir)
//      KEEP=1             keep the deployment folder afterwards
//      CONTROL_PORT, GATE_PORT, STUB_PORT   default 8877 / 8878 / 9177
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8877);
const GATE_PORT = Number(process.env.GATE_PORT || 8878);
const STUB_PORT = Number(process.env.STUB_PORT || 9177);
const FAKE_WRANGLER = join(root, 'test/scripts/fixtures/fake-wrangler.mjs');

const timings = {};
let t0 = Date.now();
const step = (msg) => {
  console.log(`\n== ${msg}`);
  t0 = Date.now();
};
const lap = (name) => (timings[name] = Math.round((Date.now() - t0) / 100) / 10);
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const capture = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

const base = process.env.TEST_PACKAGE_DIR || tmpdir();
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, 'worca-test-package-'));
const site = join(work, 'site');
const children = new Set();
let ok = false;

function cleanup() {
  // Each long-running child runs in its own process group: stop it with its workerd and esbuild children.
  for (const c of children) {
    try { process.kill(-c.pid, 'SIGTERM'); } catch {}
  }
  // Only the folder this run created (mkdtemp), never anything else.
  if (!process.env.KEEP && ok && dirname(work) === base && relative(base, work).startsWith('worca-test-package-')) rmSync(work, { recursive: true, force: true });
  else console.log(`deployment kept at ${site}`);
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: '127.0.0.1', port: u.port, path: u.pathname, headers: { host: u.host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(5000, () => req.destroy());
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`ok - ${msg}`);
}

const pack = (pkg) => {
  const out = capture('npm', ['pack', '--json', '--pack-destination', work], join(root, 'packages', pkg));
  return join(work, JSON.parse(out.slice(out.indexOf('[')))[0].filename);
};

step('pack @worca/platform and @worca/create-platform');
const platformTgz = pack('platform');
const createTgz = pack('create-platform');
mkdirSync(join(work, 'create'));
run('tar', ['-xzf', createTgz, '-C', join(work, 'create')], work);
console.log(`${platformTgz}\n${createTgz}`);
lap('pack');

step('npm create @worca/platform site (packed create-platform, non-interactive, npm install, configure)');
run(process.execPath, [
  join(work, 'create/package/bin/create-platform.mjs'), 'site', '--yes',
  '--instance-domain', 'example-instances.net', '--app-origin', 'https://app.example.com',
  '--account-id', '0123456789abcdef0123456789abcdef', '--zone-id', 'fedcba9876543210fedcba9876543210',
  '--compute', 'railway', '--railway-workspace', 'ws-test', '--features', 'newsletter,accessRequests,tiers',
  '--platform-version', `file:${platformTgz}`,
], work, { CI: '1' });
lap('create');
const configured = readFileSync(join(site, 'wrangler.control.jsonc'), 'utf8');
assert(/"name": "site-control-prod"/.test(configured) && /NewsletterSendWorkflow/.test(configured), 'create-platform installed the package and generated the wrangler configs');

step('npm run setup against a fake wrangler, twice');
const fakeEnv = { CI: '1', WORCA_WRANGLER: FAKE_WRANGLER, FAKE_WRANGLER_STATE: join(work, 'fake-wrangler.json'), RAILWAY_TOKEN: 'rw', CF_API_TOKEN: 'cf', RESEND_API_KEY: 're' };
run('npm', ['run', 'setup'], site, fakeEnv);
const state1 = JSON.parse(readFileSync(fakeEnv.FAKE_WRANGLER_STATE, 'utf8'));
const secrets1 = readFileSync(join(site, '.secrets.env'), 'utf8');
const second = capture('npm', ['run', 'setup'], site, fakeEnv);
const state2 = JSON.parse(readFileSync(fakeEnv.FAKE_WRANGLER_STATE, 'utf8'));
const again = state2.calls.slice(state1.calls.length).map((c) => c.args.slice(0, 3).join(' '));
assert(state2.d1.length === 1 && state2.kv.length === 2, 'setup created one D1 database and two KV namespaces');
assert(Object.keys(state2.workers['site-control-prod'].secrets).length >= 9 && state2.workers['site-gate-prod'].secrets.GATE_COOKIE_KEY, 'setup put the generated secrets and credentials on both Workers');
assert(!again.some((c) => / create|secret bulk/.test(c)) && readFileSync(join(site, '.secrets.env'), 'utf8') === secrets1 && /nothing to upload/.test(second), 'a second setup creates nothing and regenerates no secret');
lap('setup');

step('tsc on the deployment (types from dist/*.d.ts)');
run('npm', ['run', 'check'], site);
lap('tsc');

step('npm run deploy -- --dry-run, both Workers (real wrangler)');
run('npm', ['run', 'deploy', '--', '--dry-run'], site, { CI: '1' });
const exportsOf = (dir) => {
  const text = readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.js'))), 'utf8');
  const blocks = [...text.matchAll(/^export \{([^}]*)\}/gm)];
  return blocks.at(-1)[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).sort();
};
for (const [kind, expected] of [['gate', ['GateObject', 'GateRpc', 'default']], ['control', ['ControlRpc', 'InstanceOpsWorkflow', 'KeyRotationWorkflow', 'NewsletterSendWorkflow', 'default']]]) {
  assert(JSON.stringify(exportsOf(join(site, '.dry', kind))) === JSON.stringify(expected), `${kind} bundle exports ${expected.join(', ')}`);
}
lap('dryRun');

step('npm run dev: the local stack with fake providers');
let log = '';
const dev = spawn('npm', ['run', 'dev'], {
  cwd: site,
  detached: true,
  env: { ...process.env, CONTROL_PORT: String(CONTROL_PORT), GATE_PORT: String(GATE_PORT), STUB_PORT: String(STUB_PORT), FORCE_COLOR: '0' },
});
children.add(dev);
dev.stdout.on('data', (d) => (log += d));
dev.stderr.on('data', (d) => (log += d));
const deadline = Date.now() + 180_000;
while (!/ready\. Ctrl-C/.test(log)) {
  if (dev.exitCode !== null || /dev {5}\| error/.test(log) || Date.now() > deadline) {
    console.log(log.slice(-4000));
    throw new Error('npm run dev did not get ready');
  }
  await new Promise((r) => setTimeout(r, 500));
}
lap('devStart');
const appOrigin = `http://app.localhost:${CONTROL_PORT}`;
assert(/GateRpc\)[^\n]*\[connected\]/.test(log) && /ControlRpc\)[^\n]*\[connected\]/.test(log), 'gate → control (ControlRpc) and control → gate (GateRpc) bindings connected');
const shell = await get(`${appOrigin}/`);
assert(shell.status === 302 && /\/sign-in/.test(shell.headers.location ?? ''), 'console: / redirects to /sign-in');
const css = await get(`${appOrigin}/assets/app.css`);
assert(css.status === 200 && /text\/css/.test(css.headers['content-type'] ?? ''), 'console assets served from node_modules/@worca/platform/ui');
const signIn = await get(`${appOrigin}/sign-in`);
assert(signIn.status === 200 && /<html/i.test(signIn.body), 'sign-in page renders');
const unknown = await get(`http://nosuchinstance.run.localhost:${GATE_PORT}/`);
assert(unknown.status >= 300 && unknown.status < 500, `gate answers an unknown instance host (${unknown.status})`);

step('npm run smoke -- --env dev');
run('npm', ['run', 'smoke', '--', '--env', 'dev'], site, { CONTROL_PORT: String(CONTROL_PORT), GATE_PORT: String(GATE_PORT) });
lap('smoke');

ok = true;
console.log(`\ntest:package passed; seconds: ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.exit(0);

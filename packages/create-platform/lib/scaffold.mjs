// npm create @worca/platform <folder>: writes a deployment of @worca/platform. Every answer comes
// from a flag, else an environment variable, else a question (on a terminal), else its default;
// --yes (or no terminal) never asks and fails on a missing required answer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, confirm, interactive } from './prompt.mjs';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = join(PKG_DIR, 'templates');
const OWN_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;
export const FEATURES = ['newsletter', 'accessRequests', 'tiers'];

const isOrigin = (v) => {
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) && u.origin === v;
  } catch {
    return false;
  }
};
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** The questions, in order. `def(answers)` gives a default; `optional` may stay empty. */
export const QUESTIONS = [
  { key: 'name', flag: 'name', env: 'WORCA_NAME', text: 'Deployment name (prefix of every Cloudflare resource)', def: (a) => a.folderName,
    check: (v) => (/^[a-z][a-z0-9-]{0,17}[a-z0-9]$/.test(v) ? null : 'lowercase letters, digits and dashes, 2-19 characters, starting with a letter') },
  { key: 'instanceDomain', flag: 'instance-domain', env: 'WORCA_INSTANCE_DOMAIN', text: 'Instance domain: a Cloudflare zone, instances at <slug>.<domain>',
    check: (v) => (HOST.test(v) ? null : 'a domain, e.g. example-instances.net') },
  { key: 'appOrigin', flag: 'app-origin', env: 'WORCA_APP_ORIGIN', text: 'Console origin (on another zone than the instance domain)',
    check: (v) => (isOrigin(v) ? null : 'an origin like https://app.example.com (no path)') },
  { key: 'accountId', flag: 'account-id', env: 'WORCA_CF_ACCOUNT_ID', text: 'Cloudflare account id (dashboard → Workers & Pages, right side)', optional: true,
    check: (v) => (!v || HEX32.test(v) ? null : '32 hexadecimal characters') },
  { key: 'zoneId', flag: 'zone-id', env: 'WORCA_CF_ZONE_ID', text: 'Cloudflare zone id of the instance domain', optional: true,
    check: (v) => (!v || HEX32.test(v) ? null : '32 hexadecimal characters') },
  { key: 'compute', flag: 'compute', env: 'WORCA_COMPUTE', text: 'Compute provider for instances (railway, or fake to try the flow)', def: () => 'railway',
    check: (v) => (/^[a-z][a-z0-9-]*$/.test(v) ? null : 'a provider name: railway, fake, or one you register') },
  { key: 'railwayWorkspace', flag: 'railway-workspace', env: 'WORCA_RAILWAY_WORKSPACE_ID', text: 'Railway workspace id', optional: true, when: (a) => a.compute === 'railway' },
  { key: 'mailFrom', flag: 'mail-from', env: 'WORCA_MAIL_FROM', text: 'Mail sender (a domain you verify at Resend)',
    def: (a) => (a.appOrigin ? `Worca <no-reply@${new URL(a.appOrigin).hostname.replace(/^app\./, '')}>` : undefined),
    check: (v) => (/^([^<>]+ <[^<>\s]+@[^<>\s]+>|[^<>\s]+@[^<>\s]+)$/.test(v) ? null : 'an address, or "Name <address>"') },
  { key: 'features', flag: 'features', env: 'WORCA_FEATURES', text: `Optional modules, comma-separated (${FEATURES.join(', ')}; none)`, def: () => 'none',
    check: (v) => (v === 'none' || v.split(',').every((f) => FEATURES.includes(f.trim())) ? null : `any of ${FEATURES.join(', ')}, or none`) },
];

export const FLAG_OPTIONS = Object.fromEntries([
  ...QUESTIONS.map((q) => [q.flag, { type: 'string' }]),
  ['yes', { type: 'boolean', short: 'y' }],
  ['no-install', { type: 'boolean' }],
  ['repair', { type: 'boolean' }],
  ['platform-version', { type: 'string' }],
  ['help', { type: 'boolean', short: 'h' }],
]);

/** True when `dir` is inside a checkout of the platform's own repository (contributors use npm run dev there). */
export function insidePlatformCheckout(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'packages/platform/package.json')) && existsSync(join(d, 'packages/create-platform/package.json'))) return d;
    if (dirname(d) === d) return null;
  }
}

async function collect(flags, folderName, { ask: canAsk }) {
  const a = { folderName: folderName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 19) || 'worca' };
  for (const q of QUESTIONS) {
    if (q.when && !q.when(a)) continue;
    const given = flags[q.flag] ?? process.env[q.env];
    let v = given ?? '';
    if (given === undefined && canAsk) v = await ask(q.text, { def: q.def?.(a), validate: (x) => (!x && !q.optional ? 'required' : q.check?.(x) ?? null) });
    else if (!v) v = q.def?.(a) ?? '';
    if (!v && !q.optional) throw new Error(`missing --${q.flag} (or ${q.env})`);
    const problem = v ? q.check?.(v) : null;
    if (problem) throw new Error(`--${q.flag} ${v}: ${problem}`);
    a[q.key] = v;
  }
  if (new URL(a.appOrigin).hostname.endsWith(`.${a.instanceDomain}`) || new URL(a.appOrigin).hostname === a.instanceDomain) {
    throw new Error(`the console (${a.appOrigin}) must not be on the instance domain ${a.instanceDomain}: instances would share its site (docs/deploy.md)`);
  }
  return a;
}

/** A single-quoted TypeScript string literal. */
const str = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const render = (text, values) =>
  text.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`template placeholder {{${k}}} has no value`);
    return values[k];
  });

/** template file → deployment file */
const FILES = [
  ['package.json', 'package.json'],
  ['worca.config.ts', 'worca.config.ts'],
  ['src/control.ts', 'src/control.ts'],
  ['src/gate.ts', 'src/gate.ts'],
  ['tsconfig.json', 'tsconfig.json'],
  ['gitignore', '.gitignore'],
  ['DEPLOYMENT.md', 'README.md'],
];

/** Writes the deployment. `only`: names of files to write (repair writes the missing ones). */
export function writeDeployment(dir, a, { platformVersion = `^${OWN_VERSION}`, only } = {}) {
  const features = Object.fromEntries(FEATURES.map((f) => [f, a.features !== 'none' && a.features.split(',').map((x) => x.trim()).includes(f)]));
  const values = {
    PACKAGE_NAME: basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || a.name,
    PLATFORM_VERSION: platformVersion,
    NAME: str(a.name),
    NAME_TEXT: a.name,
    APP_ORIGIN: str(a.appOrigin),
    INSTANCE_DOMAIN: str(a.instanceDomain),
    MAIL_FROM: str(a.mailFrom),
    COMPUTE: str(a.compute),
    FEATURES: `{ ${FEATURES.map((f) => `${f}: ${features[f]}`).join(', ')} }`,
  };
  const written = [];
  for (const [from, to] of FILES) {
    if (only && !only.includes(to)) continue;
    const target = join(dir, to);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, render(readFileSync(join(TEMPLATES, from), 'utf8'), values));
    written.push(to);
  }
  if (!only || only.includes('worca.resources.json')) {
    const resources = { cloudflare: {}, compute: {}, environments: {} };
    if (a.accountId) resources.cloudflare.accountId = a.accountId;
    if (a.zoneId) resources.cloudflare.zoneId = a.zoneId;
    if (a.railwayWorkspace) resources.compute.railwayWorkspaceId = a.railwayWorkspace;
    writeFileSync(join(dir, 'worca.resources.json'), `${JSON.stringify(resources, null, 2)}\n`);
    written.push('worca.resources.json');
  }
  return written;
}

/** Answers of an existing deployment, read back from its files (for repair). */
function answersOf(dir) {
  const cfg = readFileSync(join(dir, 'worca.config.ts'), 'utf8');
  const pick = (re) => cfg.match(re)?.[1];
  return {
    name: pick(/name:\s*['"]([^'"]+)['"]/) ?? basename(dir),
    appOrigin: pick(/appOrigin:\s*['"](https?:\/\/(?!app\.localhost)[^'"]+)['"]/) ?? 'https://app.example.com',
    instanceDomain: pick(/instanceDomain:\s*['"]((?!run\.localhost)[^'"]+)['"]/) ?? 'example.net',
    mailFrom: pick(/from:\s*['"]([^'"]+)['"]/) ?? 'no-reply@example.com',
    compute: pick(/compute:\s*['"]([^'"]+)['"]/) ?? 'railway',
    features: 'none',
  };
}

const ALL_FILES = [...FILES.map(([, to]) => to), 'worca.resources.json'];

export async function main(argv, { parseArgs }) {
  const { values: flags, positionals } = parseArgs({ args: argv, options: FLAG_OPTIONS, allowPositionals: true });
  if (flags.help || !positionals[0]) {
    console.log(`usage: npm create @worca/platform <folder> [-- options]\n\n${QUESTIONS.map((q) => `  --${q.flag.padEnd(18)} ${q.env.padEnd(28)} ${q.text}`).join('\n')}
  --yes, -y            never ask: missing required answers are errors (also when there's no terminal)
  --no-install         don't run npm install (nor configure)
  --repair             in an existing deployment: write its missing files, install, configure
  --platform-version   the @worca/platform dependency (default ^${OWN_VERSION})`);
    return positionals[0] ? 0 : 1;
  }
  const dir = resolve(positionals[0]);
  const checkout = insidePlatformCheckout(dirname(dir));
  if (checkout) throw new Error(`${dir} is inside a checkout of the platform repository (${checkout}). Contributors run \`npm run dev\` there; deployments live outside it.`);
  const canAsk = interactive() && !flags.yes;

  let repair = false;
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!existsSync(join(dir, 'worca.config.ts'))) throw new Error(`${dir} isn't empty and isn't a deployment (no worca.config.ts). Use an empty or new folder.`);
    repair = flags.repair || (canAsk && (await confirm(`${dir} is an existing deployment. Continue and repair it (write missing files, install, configure)?`, true)));
    if (!repair) throw new Error(`${dir} is an existing deployment: pass --repair to write its missing files, or use another folder`);
  }

  let written;
  if (repair) {
    const missing = ALL_FILES.filter((f) => !existsSync(join(dir, f)));
    written = writeDeployment(dir, answersOf(dir), { platformVersion: flags['platform-version'], only: missing });
    console.log(written.length ? `repaired: wrote ${written.join(', ')}` : 'nothing missing');
  } else {
    if (canAsk) console.log(`Writing a deployment of @worca/platform into ${dir}\n`);
    const answers = await collect(flags, basename(dir), { ask: canAsk });
    mkdirSync(dir, { recursive: true });
    written = writeDeployment(dir, answers, { platformVersion: flags['platform-version'] });
    console.log(`\nwrote ${written.join(', ')}`);
  }

  if (!flags['no-install']) {
    console.log('\n== npm install');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    execFileSync(join(dir, 'node_modules/.bin/worca-platform'), ['configure'], { cwd: dir, stdio: 'inherit' });
  }
  const rel = relative(process.cwd(), dir) || '.';
  console.log(`
Next:
  cd ${rel}${flags['no-install'] ? '\n  npm install' : ''}
  npm run dev        the local stack with fake providers: http://app.localhost:8787
  npm run setup      Cloudflare resources, secrets and the first deploy (needs \`npx wrangler login\`)
README.md lists every command.`);
  return 0;
}

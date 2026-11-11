// The smaller commands: admin (first superadmin), secrets (status, set), upgrade.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readResources } from './deployment.mjs';
import { deploy, pickRemoteEnv } from './deploy.mjs';
import { CORE_SECRETS } from './keys.mjs';
import { askSecret, interactive } from './prompt.mjs';
import { credentialsFor, readSecrets, remoteSecretNames, secretsFile, storeSecrets, workerOf } from './secrets.mjs';
import { wranglerOk } from './wrangler.mjs';

/** POST /api/setup with SETUP_TOKEN: makes `email` the first superadmin (refused once there is one). */
export async function admin(dir, { env, email }) {
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('usage: npm run admin -- you@example.com');
  const { config, env: chosen } = await pickRemoteEnv(dir, env);
  const token = readSecrets(dir, chosen).SETUP_TOKEN;
  if (!token) throw new Error(`no SETUP_TOKEN in ${secretsFile(dir, chosen)} (npm run setup writes it)`);
  const origin = config.environments[chosen].appOrigin;
  const res = await fetch(`${origin}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token, email }) });
  if (res.status === 409) return console.log(`${origin} already has a superadmin; sign in at ${origin}/sign-in`);
  if (!res.ok) throw new Error(`POST ${origin}/api/setup: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  console.log(`${email} is the superadmin of ${origin}. Sign in at ${origin}/sign-in with an email code, then add a passkey.`);
}

/** Which secrets each Worker has, and which the configuration expects. */
export async function secretsStatus(dir, { env }) {
  const { config, env: chosen } = await pickRemoteEnv(dir, env);
  const expected = {
    gate: CORE_SECRETS.gate.map((name) => ({ name })),
    control: [...CORE_SECRETS.control.map((name) => ({ name })), ...credentialsFor(config, readResources(dir))],
  };
  const stored = readSecrets(dir, chosen);
  for (const kind of ['gate', 'control']) {
    const remote = await remoteSecretNames(dir, kind, chosen);
    console.log(`\n${kind} (${chosen}):`);
    for (const s of expected[kind]) {
      console.log(`  ${remote.includes(s.name) ? 'set    ' : 'MISSING'} ${s.name}${stored[s.name] ? '' : remote.includes(s.name) ? '  (not in .secrets file)' : ''}${s.why && !remote.includes(s.name) ? `  ${s.why}` : ''}`);
    }
    for (const name of remote.filter((n) => !expected[kind].some((s) => s.name === n))) console.log(`  set     ${name}`);
  }
}

/** Puts one secret on the Worker that reads it, and keeps it in the .secrets file. Value: env, prompt or stdin. */
export async function secretsSet(dir, { env, name }) {
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('usage: npm run secrets -- set NAME');
  const { env: chosen } = await pickRemoteEnv(dir, env);
  let value = process.env[name];
  if (!value && interactive()) value = await askSecret(name);
  if (!value && !process.stdin.isTTY) value = readFileSync(0, 'utf8').trim();
  if (!value) throw new Error(`no value for ${name}`);
  const kind = workerOf(name);
  await wranglerOk(['secret', 'put', name, '-c', `wrangler.${kind}.jsonc`, '--env', chosen], { cwd: dir, input: value });
  storeSecrets(dir, chosen, { ...readSecrets(dir, chosen), [name]: value });
  console.log(`${name} set on the ${kind} Worker and kept in ${secretsFile(dir, chosen)}`);
}

const versionOf = (dir) => JSON.parse(readFileSync(join(dir, 'node_modules/@worca/platform/package.json'), 'utf8')).version;

/** The CHANGELOG sections newer than `from`, up to the installed version. */
function changesSince(dir, from) {
  const file = join(dir, 'node_modules/@worca/platform/CHANGELOG.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const at = text.search(new RegExp(`^##\\s*\\[?${from.replace(/\./g, '\\.')}\\b`, 'm'));
  return (at > 0 ? text.slice(0, at) : text).trim();
}

/** npm i @worca/platform@<tag>, the changes since the installed version, then deploy. */
export async function upgrade(dir, { env, tag = 'latest', deployAfter = true }) {
  const before = versionOf(dir);
  execFileSync('npm', ['install', `@worca/platform@${tag}`], { cwd: dir, stdio: 'inherit' });
  const after = versionOf(dir);
  if (after === before) return console.log(`@worca/platform is already ${after}`);
  console.log(`\n@worca/platform ${before} → ${after}`);
  const changes = changesSince(dir, before);
  console.log(changes ? `\n${changes}\n` : '(no CHANGELOG.md in the package; see the GitHub release notes)');
  if (deployAfter) await deploy(dir, { env });
}

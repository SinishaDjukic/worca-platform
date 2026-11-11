// `npm run setup` (worca-platform setup): everything a fresh Cloudflare account needs, safe to run
// again. Each step finds what exists before it creates anything; generated secrets are made only
// when neither .secrets.env nor the Worker has them.
//   1. D1 database and both KV namespaces, found by name or created; ids into worca.resources.json
//   2. wrangler configs from worca.config.ts
//   3. migrations
//   4. secrets: the six generated ones, then the provider credentials (asked, or from the env)
//   5. the gate, then the control plane
//   6. how to become the first superadmin, and what's left by hand
import { resourceNames } from '../dist/index.js';
import { kvTitles, readResources, writeResources, writeWranglerConfigs } from './deployment.mjs';
import { applyMigrations, buildAssets, deployWorker, pickRemoteEnv } from './deploy.mjs';
import { CORE_SECRETS } from './keys.mjs';
import { generateSecrets } from './keys.mjs';
import { askSecret, interactive } from './prompt.mjs';
import { credentialsFor, readSecrets, remoteSecretNames, secretsFile, storeSecrets, uploadSecrets } from './secrets.mjs';
import { parseJsonOutput, wrangler, wranglerOk } from './wrangler.mjs';

const step = (msg) => console.log(`\n== ${msg}`);

async function findDatabase(dir, name) {
  const res = await wranglerOk(['d1', 'list', '--json'], { cwd: dir, capture: true });
  return parseJsonOutput(res.stdout).find((d) => d.name === name)?.uuid ?? null;
}

async function findNamespace(dir, title) {
  const res = await wranglerOk(['kv', 'namespace', 'list'], { cwd: dir, capture: true });
  return parseJsonOutput(res.stdout).find((n) => n.title === title)?.id ?? null;
}

/** `wrangler d1 create` flags for the config's `database` placement. */
export function d1Placement(config) {
  const d = config.database ?? {};
  if (d.jurisdiction) return ['--jurisdiction', d.jurisdiction];
  if (d.location) return ['--location', d.location];
  return [];
}

/** Finds or creates; returns { id, created }. */
async function ensure(what, find, create) {
  const found = await find();
  if (found) {
    console.log(`  ${what}: found ${found}`);
    return { id: found, created: false };
  }
  await create();
  const id = await find();
  if (!id) throw new Error(`${what}: created, but wrangler doesn't list it`);
  console.log(`  ${what}: created ${id}`);
  return { id, created: true };
}

export async function setup(dir, { env: wanted } = {}) {
  const { config, env } = await pickRemoteEnv(dir, wanted);
  const names = resourceNames(config, env);
  const titles = kvTitles(config, env);
  const report = { created: [], generated: [], uploaded: [], missing: [] };

  step('Cloudflare login');
  const who = await wrangler(['whoami'], { cwd: dir, capture: true });
  if (who.code !== 0 || /not authenticated/i.test(who.stdout)) throw new Error('wrangler is not logged in: run `npx wrangler login` (or set CLOUDFLARE_API_TOKEN) and try again');
  console.log(`  ${who.stdout.split('\n').find((l) => /logged in|associated with/i.test(l))?.trim() ?? 'logged in'}`);

  step(`resources of ${env}`);
  const resources = readResources(dir);
  const db = await ensure(`D1 ${names.database}`, () => findDatabase(dir, names.database), () => wranglerOk(['d1', 'create', names.database, ...d1Placement(config)], { cwd: dir, capture: true }));
  const kv = await ensure(`KV ${titles.control}`, () => findNamespace(dir, titles.control), () => wranglerOk(['kv', 'namespace', 'create', titles.control], { cwd: dir, capture: true }));
  const hosts = await ensure(`KV ${titles.hosts}`, () => findNamespace(dir, titles.hosts), () => wranglerOk(['kv', 'namespace', 'create', titles.hosts], { cwd: dir, capture: true }));
  for (const [what, r] of [[names.database, db], [titles.control, kv], [titles.hosts, hosts]]) if (r.created) report.created.push(what);
  resources.environments[env] = { ...resources.environments[env], databaseId: db.id, controlKvId: kv.id, hostsKvId: hosts.id };
  writeResources(dir, resources);
  await writeWranglerConfigs(dir);
  console.log('  wrote worca.resources.json, wrangler.control.jsonc, wrangler.gate.jsonc');

  // Before any Worker exists: a Worker deployed for its secrets below already finds its tables.
  await applyMigrations(dir, config, env);

  step('secrets');
  const stored = readSecrets(dir, env);
  const remote = { control: await remoteSecretNames(dir, 'control', env), gate: await remoteSecretNames(dir, 'gate', env) };
  const upload = { control: {}, gate: {} };
  for (const [kind, list] of Object.entries(CORE_SECRETS)) {
    for (const name of list) {
      if (remote[kind].includes(name)) {
        if (!stored[name]) console.log(`  ${name}: set on the ${kind} Worker but not in ${secretsFile(dir, env)}; kept`);
        continue;
      }
      if (!stored[name]) {
        Object.assign(stored, await generateSecrets([name], { kidPrefix: config.name }));
        report.generated.push(name);
      }
      upload[kind][name] = stored[name];
    }
  }
  for (const c of credentialsFor(config, resources)) {
    if (remote[c.worker].includes(c.name)) continue;
    let value = stored[c.name] || process.env[c.name] || c.known;
    if (!value && interactive()) value = await askSecret(`${c.name}: ${c.why} (empty: skip)`);
    if (!value) {
      report.missing.push(c);
      continue;
    }
    stored[c.name] = value;
    upload[c.worker][c.name] = value;
  }
  // Written before anything is uploaded: a generated key must never exist only on Cloudflare.
  storeSecrets(dir, env, stored);
  console.log(`  ${secretsFile(dir, env)} (mode 600) holds ${Object.keys(stored).length} values`);
  // The gate first: a Worker that doesn't exist yet is deployed, then given its secrets.
  const exists = { gate: remote.gate.length > 0, control: remote.control.length > 0 };
  for (const kind of ['gate', 'control']) {
    if (!Object.keys(upload[kind]).length) continue;
    try {
      await uploadSecrets(dir, kind, env, upload[kind]);
    } catch (e) {
      if (!/not.?found|10007|does not exist/i.test(e.message)) throw e;
      console.log(`  the ${kind} Worker doesn't exist yet: deploying it first`);
      if (kind === 'control' && !exists.gate) await deployWorker(dir, 'gate', env);
      await deployWorker(dir, kind, env);
      exists.gate ||= kind === 'gate';
      await uploadSecrets(dir, kind, env, upload[kind]);
    }
    report.uploaded.push(...Object.keys(upload[kind]));
  }
  if (!report.uploaded.length) console.log('  nothing to upload: every secret is already set');

  step(`deploy ${env}`);
  buildAssets(dir);
  await deployWorker(dir, 'gate', env);
  await deployWorker(dir, 'control', env);

  const e = config.environments[env];
  step('done');
  if (report.generated.includes('MASTER_KEY')) {
    console.log(`
  !! ${secretsFile(dir, env)} now holds this deployment's keys. Copy it into a password manager now.
  !! MASTER_KEY encrypts tenant data: without it, no backup of the database can be read (D36).`);
  }
  console.log(`
  Console:     ${e.appOrigin}
  Instances:   https://<slug>.${e.instanceDomain}

  Make yourself the first superadmin (once; SETUP_TOKEN is in ${secretsFile(dir, env).split('/').pop()}):
    npm run admin -- you@example.com
  then sign in at ${e.appOrigin}/sign-in with that address.

  Still to do by hand (docs/deploy.md in github.com/SinishaDjukic/worca-platform):
    - verify the mail sender's domain at Resend (${config.mail.from})
    - request ${e.instanceDomain} on the Public Suffix List (D12: until it is listed, the gate alone
      keeps instances apart)`);
  if (report.missing.length) {
    console.log('\n  Not set yet (npm run secrets -- set NAME):');
    for (const c of report.missing) console.log(`    ${c.name}: ${c.why}`);
  }
  return report;
}

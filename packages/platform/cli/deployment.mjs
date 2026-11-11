// A deployment folder as the CLI sees it: its worca.config.ts, the ids `setup` found or created
// (worca.resources.json), and the wrangler configs generated from both. Node only; the config
// helpers come from the package's own dist/.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePlatformConfig, resourceNames, wranglerVars } from '../dist/index.js';

export const CONFIG_FILE = 'worca.config.ts';
export const RESOURCES_FILE = 'worca.resources.json';
export const CRONS = ['*/5 * * * *', '17 3 * * *'];
export const COMPATIBILITY_DATE = '2026-08-20';
/** Local-only ids of a `local` environment: wrangler dev keeps its data under .wrangler/state. */
const LOCAL_DATABASE_ID = '00000000-0000-0000-0000-000000000000';

/** Loads and validates the deployment's worca.config.ts (Node strips its types). */
export async function loadConfig(dir) {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${file} not found: run this inside a deployment folder (npm create @worca/platform)`);
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return parsePlatformConfig(mod.default);
}

/** The deployment's environments that run on Cloudflare (not `local`), in config order. */
export const remoteEnvs = (config) => Object.entries(config.environments).filter(([, e]) => !e.local).map(([name]) => name);
export const localEnvs = (config) => Object.entries(config.environments).filter(([, e]) => e.local).map(([name]) => name);

/**
 * worca.resources.json: { cloudflare: { accountId, zoneId }, compute: { railwayWorkspaceId },
 * environments: { prod: { databaseId, controlKvId, hostsKvId } } }. Ids, not secrets: commit it.
 */
export function readResources(dir) {
  const file = join(dir, RESOURCES_FILE);
  const empty = { cloudflare: {}, environments: {} };
  if (!existsSync(file)) return empty;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  return { ...r, cloudflare: r.cloudflare ?? {}, environments: r.environments ?? {} };
}

export function writeResources(dir, resources) {
  writeFileSync(join(dir, RESOURCES_FILE), `${JSON.stringify(resources, null, 2)}\n`);
}

/** Names of the KV namespaces of one environment (D1 and Workers come from resourceNames). */
export function kvTitles(config, env) {
  return { control: `${config.name}-control-kv-${env}`, hosts: `${config.name}-hosts-${env}` };
}

export const hasBranding = (dir) => existsSync(join(dir, 'branding'));

/** Routes of a remote environment: the app on its host, instances on the instance domain (D67). */
function routes(envConfig) {
  const app = new URL(envConfig.appOrigin).hostname;
  const d = envConfig.instanceDomain;
  return {
    control: [{ pattern: app, custom_domain: true }],
    gate: [
      { pattern: `*.${d}/*`, zone_name: d },
      { pattern: d, custom_domain: true },
      { pattern: `www.${d}`, custom_domain: true },
    ],
  };
}

/**
 * Both wrangler configs, every environment of the config in each. `resources` supplies the ids of
 * remote environments; an id `setup` hasn't found yet is left as a placeholder that wrangler
 * refuses, so nothing deploys against the wrong database.
 */
export function wranglerConfigs(config, resources, { branding = false } = {}) {
  const control = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: `${config.name}-control`,
    main: 'src/control.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    assets: {
      directory: branding ? '.assets' : 'node_modules/@worca/platform/ui',
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
      not_found_handling: 'none',
    },
    env: {},
  };
  const gate = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: `${config.name}-gate`,
    main: 'src/gate.ts',
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ['nodejs_compat'],
    env: {},
    // GateObject's class name and this tag are permanent: a rename needs a renamed_classes migration.
    migrations: [{ tag: 'v1', new_sqlite_classes: ['GateObject'] }],
  };
  const accountId = resources.cloudflare?.accountId;
  if (accountId) {
    control.account_id = accountId;
    gate.account_id = accountId;
  }
  for (const [env, e] of Object.entries(config.environments)) {
    const names = resourceNames(config, env);
    const vars = wranglerVars(config, env);
    const ids = e.local
      ? { databaseId: LOCAL_DATABASE_ID, controlKvId: `${config.name}-control-kv-${env}`, hostsKvId: `${config.name}-hosts-${env}` }
      : { databaseId: 'run-npm-run-setup', controlKvId: 'run-npm-run-setup', hostsKvId: 'run-npm-run-setup', ...resources.environments?.[env] };
    const r = e.local ? { control: [], gate: [] } : routes(e);
    const workflows = [
      { name: names.instanceOps, binding: 'INSTANCE_OPS', class_name: 'InstanceOpsWorkflow' },
      { name: names.keyRotation, binding: 'KEY_ROTATION', class_name: 'KeyRotationWorkflow' },
    ];
    // The newsletter's Workflow only when the module is on (2.4): its binding is optional.
    if (config.features.newsletter) workflows.push({ name: names.newsletterSend, binding: 'NEWSLETTER_SEND', class_name: 'NewsletterSendWorkflow' });
    control.env[env] = {
      name: names.control,
      ...(r.control.length ? { routes: r.control } : {}),
      vars: vars.control,
      d1_databases: [{ binding: 'DB', database_name: names.database, database_id: ids.databaseId, migrations_dir: 'node_modules/@worca/platform/migrations' }],
      kv_namespaces: [{ binding: 'KV', id: ids.controlKvId }],
      services: [{ binding: 'GATE', service: names.gate, entrypoint: 'GateRpc' }],
      workflows,
      triggers: { crons: CRONS },
    };
    gate.env[env] = {
      name: names.gate,
      ...(r.gate.length ? { routes: r.gate } : {}),
      vars: vars.gate,
      kv_namespaces: [{ binding: 'HOSTS', id: ids.hostsKvId }],
      durable_objects: { bindings: [{ name: 'GATE_OBJECT', class_name: 'GateObject' }] },
      services: [{ binding: 'CONTROL', service: names.control, entrypoint: 'ControlRpc' }],
    };
  }
  return { control, gate };
}

const HEADER = {
  control: '// Control plane. Generated from worca.config.ts and worca.resources.json by `worca-platform configure`\n// (npm run setup and npm run deploy run it): edit those, not this file.\n',
  gate: '// Gate: every request to an instance. Generated from worca.config.ts and worca.resources.json by\n// `worca-platform configure`: edit those, not this file.\n',
};

/** Writes wrangler.control.jsonc and wrangler.gate.jsonc; returns the configs. */
export async function writeWranglerConfigs(dir) {
  const config = await loadConfig(dir);
  const configs = wranglerConfigs(config, readResources(dir), { branding: hasBranding(dir) });
  for (const kind of ['control', 'gate']) {
    writeFileSync(join(dir, `wrangler.${kind}.jsonc`), `${HEADER[kind]}${JSON.stringify(configs[kind], null, 2)}\n`);
  }
  return { config, configs };
}

/** KEY='value' lines (.dev.vars, .secrets.env) as an object. */
export function readEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Writes an env file readable only by its owner (mode 600). Values must not contain a single quote. */
export function writeEnvFile(file, values) {
  for (const [k, v] of Object.entries(values)) if (String(v).includes("'")) throw new Error(`${k}: a value with a single quote can't be written to ${file}`);
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its mode on write
}

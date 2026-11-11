// Worker secrets of a deployment: the six the platform generates (keys.mjs) and the provider
// credentials a person supplies. Values live on the Workers and in .secrets.env (mode 600,
// gitignored), never anywhere else; they reach wrangler on stdin.
import { join } from 'node:path';
import { CORE_SECRETS } from './keys.mjs';
import { readEnvFile, writeEnvFile } from './deployment.mjs';
import { parseJsonOutput, wrangler, wranglerOk } from './wrangler.mjs';

/** .secrets.env for prod, .secrets.<env>.env for any other remote environment. */
export const secretsFile = (dir, env) => join(dir, env === 'prod' ? '.secrets.env' : `.secrets.${env}.env`);

/**
 * The credentials the configured providers need, all on the control plane. `known` fills values
 * that aren't secret but are read as secrets (ids from worca.resources.json).
 */
export function credentialsFor(config, resources) {
  const providers = { ...config.providers };
  const list = [];
  if (providers.compute === 'railway') {
    list.push({ name: 'RAILWAY_TOKEN', why: 'Railway workspace token (Railway: workspace settings → Tokens)' });
    list.push({ name: 'RAILWAY_WORKSPACE_ID', why: 'Railway workspace id', known: resources.compute?.railwayWorkspaceId });
  }
  if (providers.edge === 'cloudflare') {
    list.push({ name: 'CF_API_TOKEN', why: 'Cloudflare API token: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit and Zone › Zone › Read on the instance domain (docs/deploy.md)' });
    list.push({ name: 'CF_ACCOUNT_ID', why: 'Cloudflare account id', known: resources.cloudflare?.accountId });
    list.push({ name: 'CF_ZONE_ID', why: 'Cloudflare zone id of the instance domain', known: resources.cloudflare?.zoneId });
  }
  list.push({ name: 'RESEND_API_KEY', why: 'Resend API key with sending access (mail: sign-in codes, invitations)' });
  return list.map((c) => ({ ...c, worker: 'control' }));
}

/** Names of the secrets set on one Worker; [] when the Worker doesn't exist yet. */
export async function remoteSecretNames(dir, kind, env) {
  const res = await wrangler(['secret', 'list', '-c', `wrangler.${kind}.jsonc`, '--env', env, '--format', 'json'], { cwd: dir, capture: true });
  if (res.code !== 0) return [];
  try {
    return parseJsonOutput(res.stdout).map((s) => s.name);
  } catch {
    return [];
  }
}

export async function uploadSecrets(dir, kind, env, values) {
  const names = Object.keys(values);
  if (!names.length) return;
  console.log(`  ${kind}: uploading ${names.join(', ')}`);
  await wranglerOk(['secret', 'bulk', '-c', `wrangler.${kind}.jsonc`, '--env', env], { cwd: dir, input: JSON.stringify(values), capture: true });
}

export function readSecrets(dir, env) {
  return readEnvFile(secretsFile(dir, env));
}

export function storeSecrets(dir, env, values) {
  writeEnvFile(secretsFile(dir, env), values);
}

export const workerOf = (name) => (CORE_SECRETS.gate.includes(name) ? 'gate' : 'control');

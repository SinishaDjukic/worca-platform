// `worca-platform deploy`: configs from worca.config.ts, the branding overlay, migrations, then the
// gate and the control plane (in that order: the control plane's service binding needs the gate).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasBranding, loadConfig, remoteEnvs, writeWranglerConfigs } from './deployment.mjs';
import { resourceNames } from '../dist/index.js';
import { wranglerOk } from './wrangler.mjs';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The branding/ overlay over the package's ui/ into .assets (docs/branding.md). */
export function buildAssets(dir) {
  if (!hasBranding(dir)) return false;
  execFileSync(process.execPath, [join(PACKAGE_DIR, 'scripts/brand-assets.mjs'), '--ui', join(PACKAGE_DIR, 'ui'), '--branding', join(dir, 'branding'), '--out', join(dir, '.assets')], {
    cwd: dir,
    stdio: 'inherit',
  });
  return true;
}

export async function pickRemoteEnv(dir, env) {
  const config = await loadConfig(dir);
  const remote = remoteEnvs(config);
  const chosen = env ?? (remote.includes('prod') ? 'prod' : remote[0]);
  if (!chosen || !remote.includes(chosen)) {
    throw new Error(`no remote environment "${env ?? ''}" in worca.config.ts (remote: ${remote.join(', ') || 'none'}; local environments run with npm run dev)`);
  }
  return { config, env: chosen };
}

export async function applyMigrations(dir, config, env) {
  const db = resourceNames(config, env).database;
  console.log(`\n== migrations: ${db}`);
  await wranglerOk(['d1', 'migrations', 'apply', db, '--remote', '-c', 'wrangler.control.jsonc', '--env', env], { cwd: dir });
}

export async function deployWorker(dir, kind, env, { dryRun = false } = {}) {
  console.log(`\n== deploy ${kind}${dryRun ? ' (dry run)' : ''}`);
  const args = ['deploy', '-c', `wrangler.${kind}.jsonc`, '--env', env];
  if (dryRun) args.push('--dry-run', '--outdir', join('.dry', kind));
  await wranglerOk(args, { cwd: dir });
}

/** configure → assets → migrations → gate → control. `dryRun` bundles both and touches nothing. */
export async function deploy(dir, { env, dryRun = false } = {}) {
  const picked = await pickRemoteEnv(dir, env);
  await writeWranglerConfigs(dir);
  buildAssets(dir);
  if (!dryRun) await applyMigrations(dir, picked.config, picked.env);
  await deployWorker(dir, 'gate', picked.env, { dryRun });
  await deployWorker(dir, 'control', picked.env, { dryRun });
  console.log(`\n${dryRun ? 'dry run done: bundles in .dry/' : `deployed ${picked.env}: ${picked.config.environments[picked.env].appOrigin}`}`);
}

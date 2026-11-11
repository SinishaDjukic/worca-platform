// `npm run dev` (worca-platform dev): the deployment's local environment in one terminal, with the
// fake providers: .dev.vars, local migrations, the stub instance server, the gate and the control
// plane. Ctrl-C stops everything.
//
// Env: CONTROL_PORT, GATE_PORT, STUB_PORT (default 8787 / 8798 / 9100; other ports override the
// local environment's origins with --var), PERSIST_TO (default .wrangler/state).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourceNames } from '../dist/index.js';
import { loadConfig, localEnvs, writeEnvFile, writeWranglerConfigs } from './deployment.mjs';
import { buildAssets } from './deploy.mjs';
import { generateSecrets } from './keys.mjs';
import { wranglerCommand } from './wrangler.mjs';

const STUB = fileURLToPath(new URL('../stub/instance.mjs', import.meta.url));

export async function dev(dir, { env: wanted } = {}) {
  const config = await loadConfig(dir);
  const env = wanted ?? localEnvs(config)[0];
  const e = config.environments[env];
  if (!e?.local) throw new Error(`no local environment ${wanted ? `"${wanted}" ` : ''}in worca.config.ts (one with local: true)`);
  const appPort = Number(new URL(e.appOrigin).port || 80);
  const CONTROL_PORT = Number(process.env.CONTROL_PORT || appPort);
  const GATE_PORT = Number(process.env.GATE_PORT || (e.instanceOriginSuffix ? e.instanceOriginSuffix.slice(1) : 8798));
  const STUB_PORT = Number(process.env.STUB_PORT || (e.stubAdminUrl ? new URL(e.stubAdminUrl).port : 9100));
  const PERSIST_TO = process.env.PERSIST_TO || '.wrangler/state';
  const appOrigin = `${new URL(e.appOrigin).protocol}//${new URL(e.appOrigin).hostname}:${CONTROL_PORT}`;
  const [wcmd, wpre] = wranglerCommand(dir);
  const children = new Set();
  let stopping = false;

  const say = (msg) => process.stdout.write(`dev     | ${msg}\n`);
  const start = (name, cmd, args, extraEnv = {}, keep = true) => {
    const child = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    children.add(child);
    for (const s of [child.stdout, child.stderr]) {
      let buf = '';
      s.setEncoding('utf8').on('data', (c) => {
        buf += c;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) process.stdout.write(`${name.padEnd(7)} | ${l}\n`);
      });
    }
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (keep && !stopping) {
        say(`${name} exited (${signal ?? code}); stopping everything`);
        shutdown(1);
      }
    });
    return child;
  };
  const run = (name, cmd, args, extraEnv) =>
    new Promise((resolve, reject) => start(name, cmd, args, extraEnv, false).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code})`)))));
  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const c of children) {
      try { process.kill(-c.pid, 'SIGTERM'); } catch { c.kill('SIGTERM'); }
    }
    setTimeout(() => process.exit(code), 3000).unref();
    const t = setInterval(() => { if (!children.size) { clearInterval(t); process.exit(code); } }, 100);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  for (const [name, port] of [['CONTROL_PORT', CONTROL_PORT], ['GATE_PORT', GATE_PORT], ['STUB_PORT', STUB_PORT]]) {
    if (await answers(port)) throw new Error(`${name} ${port} is in use; stop what holds it or pick another (${name}=… npm run dev)`);
  }

  await writeWranglerConfigs(dir);
  buildAssets(dir);
  const devVars = join(dir, '.dev.vars');
  if (!existsSync(devVars)) {
    writeEnvFile(devVars, await generateSecrets(undefined, { kidPrefix: 'dev' }));
    say('wrote .dev.vars (local secrets for both Workers)');
  }
  const names = resourceNames(config, env);
  await run('migrate', wcmd, [...wpre, 'd1', 'migrations', 'apply', names.database, '--local', '-c', 'wrangler.control.jsonc', '--env', env, '--persist-to', PERSIST_TO], { CI: '1' });

  start('stub', process.execPath, [STUB], { STUB_PORT: String(STUB_PORT), APP_ORIGIN: appOrigin, STUB_HEARTBEAT_SECONDS: process.env.STUB_HEARTBEAT_SECONDS || '5' });
  const varArgs = (obj) => Object.entries(obj).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  // The local stack deploys the stub, not images: publishing a release skips the image check.
  const controlVars = { RELEASE_IMAGE_CHECK: 'off', APP_ORIGIN: appOrigin, INSTANCE_ORIGIN_SUFFIX: `:${GATE_PORT}`, STUB_ADMIN_URL: `http://127.0.0.1:${STUB_PORT}` };
  const common = ['--env', env, '--persist-to', PERSIST_TO, '--show-interactive-dev-session=false'];
  start('gate', wcmd, [...wpre, 'dev', '-c', 'wrangler.gate.jsonc', ...common, '--port', String(GATE_PORT), '--inspector-port', String(GATE_PORT + 2442), ...varArgs({ APP_ORIGIN: appOrigin })]);
  start('control', wcmd, [...wpre, 'dev', '-c', 'wrangler.control.jsonc', ...common, '--port', String(CONTROL_PORT), '--inspector-port', String(CONTROL_PORT + 2442), ...varArgs(controlVars)]);

  const ready = async (what, url, ok) => {
    const deadline = Date.now() + 120_000;
    while (!stopping) {
      if (ok(await probe(url))) return say(`${what} is ready`);
      if (Date.now() > deadline) throw new Error(`${what} not ready after 120 s`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  try {
    await ready('stub', `http://127.0.0.1:${STUB_PORT}/__admin/health`, (s) => s === 200);
    await ready('control', `${appOrigin}/health`, (s) => s === 200);
    await ready('gate', `http://${e.instanceDomain}:${GATE_PORT}/`, (s) => s > 0);
  } catch (err) {
    say(`error: ${err.message}`);
    shutdown(1);
    return;
  }
  say('');
  say(`console    ${appOrigin}  (first superadmin: SETUP_TOKEN in .dev.vars, or npm run smoke)`);
  say(`instances  http://<slug>.${e.instanceDomain}:${GATE_PORT}`);
  say(`mail       ${appOrigin}/__dev/mail?to=<email>`);
  say('ready. Ctrl-C stops everything.');
}

function probe(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: '127.0.0.1', port: u.port, path: u.pathname, headers: { host: u.host }, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

function answers(port) {
  const one = (host) => new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
  return one('127.0.0.1').then((a) => a || one('::1'));
}

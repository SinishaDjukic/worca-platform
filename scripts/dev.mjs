// `npm run dev`: the whole local stack in one terminal.
//   1. .dev.vars (scripts/dev-keys.mjs; keeps an existing file)
//   2. local D1 migrations (the `migrate:local` script)
//   3. stub instance server, control plane (`dev:control`), gate (`dev:gate`)
//   4. waits until all three answer, prints the URLs; Ctrl-C stops everything.
//
// Env:
//   E2E_FAST=1            short gate timers for the e2e suites: IDLE_SECONDS=20, RECHECK_SECONDS=10,
//                         PASS_SECONDS=5, SCHEDULE_WAKE_LEAD_SECONDS=30 (gate --var), heartbeats every 2 s
//   CONTROL_PORT, GATE_PORT, STUB_PORT   default 8787 / 8798 / 9100; the e2e and UI tests read the
//                         same three. Other ports also override APP_ORIGIN, INSTANCE_ORIGIN_SUFFIX
//                         and STUB_ADMIN_URL with --var. A port already in use stops the start.
//   PERSIST_TO            default .wrangler/state
//   SKIP_MIGRATIONS=1     don't apply migrations
//   FEATURES              the control plane's optional modules (2.4), e.g. FEATURES=none to try the
//                         console without them; unset: dev.config.ts's (wrangler.control.jsonc)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wranglerBin = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));

const FAST = process.env.E2E_FAST === '1';
const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8787);
const GATE_PORT = Number(process.env.GATE_PORT || 8798);
const STUB_PORT = Number(process.env.STUB_PORT || 9100);
const PERSIST_TO = process.env.PERSIST_TO || '.wrangler/state';
const APP_ORIGIN = `http://app.localhost:${CONTROL_PORT}`;

const FAST_GATE_VARS = { IDLE_SECONDS: '20', RECHECK_SECONDS: '10', PASS_SECONDS: '5', SCHEDULE_WAKE_LEAD_SECONDS: '30' };
const FAST_HEARTBEAT_SECONDS = '2';

const colors = { dev: 90, migrate: 35, stub: 36, control: 32, gate: 33 };
const children = new Set();
let stopping = false;

function out(name, line) {
  const c = colors[name] ?? 37;
  process.stdout.write(`\x1b[${c}m${name.padEnd(7)}|\x1b[0m ${line}\n`);
}
const say = (msg) => out('dev', msg);

function pipeLines(name, stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) out(name, l);
  });
  stream.on('end', () => buf && out(name, buf));
}

function start(name, cmd, args, { env = {}, keep = true } = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // own process group, so we can stop wrangler's children
  });
  children.add(child);
  pipeLines(name, child.stdout);
  pipeLines(name, child.stderr);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (keep && !stopping) {
      say(`${name} exited (${signal ?? code}); stopping everything`);
      shutdown(1);
    }
  });
  return child;
}

function run(name, cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = start(name, cmd, args, { ...opts, keep: false });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed with exit code ${code}`))));
  });
}

/** The package.json script as argv for wrangler, with port and persistence overridden. */
function wranglerArgs(script, extra = []) {
  const cmd = pkg.scripts[script];
  if (!cmd) throw new Error(`package.json has no "${script}" script`);
  const argv = cmd.trim().split(/\s+/);
  if (argv[0] !== 'wrangler') throw new Error(`"${script}" is not a wrangler command: ${cmd}`);
  argv.shift();
  const set = (flag, value) => {
    const i = argv.indexOf(flag);
    if (i >= 0) argv[i + 1] = value;
    else argv.push(flag, value);
  };
  if (argv.includes('--persist-to')) set('--persist-to', PERSIST_TO);
  return { argv, set, extra };
}

function vars(obj) {
  return Object.entries(obj).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
}

function probe(url, host) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ hostname: '127.0.0.1', port: u.port, path: u.pathname, headers: { host: host ?? u.host }, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function waitFor(name, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping) {
    if (await check()) return say(`${name} is ready`);
    if (Date.now() > deadline) throw new Error(`${name} not ready after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  say('stopping…');
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  const hard = setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    process.exit(code);
  }, 5000);
  hard.unref();
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      process.exit(code);
    }
  }, 100);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** True when nothing answers on the port at 127.0.0.1 or ::1 (a test bind can succeed on macOS anyway). */
async function portFree(port) {
  const answers = (host) => new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(1000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
  return !(await answers('127.0.0.1')) && !(await answers('::1'));
}

async function main() {
  const busy = [];
  for (const [name, port] of [['CONTROL_PORT', CONTROL_PORT], ['GATE_PORT', GATE_PORT], ['STUB_PORT', STUB_PORT]]) {
    if (!(await portFree(port))) busy.push(`${name} ${port}`);
  }
  if (busy.length) throw new Error(`port in use: ${busy.join(', ')}. Stop what holds it, or pick another (e.g. GATE_PORT=8799 npm run dev, and the same variable for the tests)`);

  say(`E2E_FAST=${FAST ? '1' : '0'}; control :${CONTROL_PORT}, gate :${GATE_PORT}, stub :${STUB_PORT}; state in ${PERSIST_TO}`);

  await run('dev', process.execPath, [fileURLToPath(new URL('./dev-keys.mjs', import.meta.url))]);

  if (process.env.SKIP_MIGRATIONS !== '1') {
    const m = wranglerArgs('migrate:local');
    await run('migrate', wranglerBin, m.argv, { env: { CI: '1' } });
  }

  start('stub', process.execPath, [fileURLToPath(new URL('../packages/platform/stub/instance.mjs', import.meta.url))], {
    env: {
      STUB_PORT: String(STUB_PORT),
      APP_ORIGIN,
      STUB_HEARTBEAT_SECONDS: process.env.STUB_HEARTBEAT_SECONDS || (FAST ? FAST_HEARTBEAT_SECONDS : '5'),
      FORCE_COLOR: '0',
    },
  });

  const portVars = {};
  if (CONTROL_PORT !== 8787) portVars.APP_ORIGIN = APP_ORIGIN;
  const control = wranglerArgs('dev:control');
  control.set('--port', String(CONTROL_PORT));
  // The local stack deploys the stub, not images: publishing a release skips the GHCR check.
  const controlVars = { ...portVars, RELEASE_IMAGE_CHECK: 'off' };
  if (GATE_PORT !== 8798) controlVars.INSTANCE_ORIGIN_SUFFIX = `:${GATE_PORT}`;
  if (STUB_PORT !== 9100) controlVars.STUB_ADMIN_URL = `http://127.0.0.1:${STUB_PORT}`;
  if (process.env.FEATURES !== undefined) controlVars.FEATURES = process.env.FEATURES || 'none';
  start('control', wranglerBin, [...control.argv, ...vars(controlVars), '--inspector-port', String(CONTROL_PORT + 2442)]);

  const gate = wranglerArgs('dev:gate');
  gate.set('--port', String(GATE_PORT));
  const gateVars = { ...portVars, ...(FAST ? FAST_GATE_VARS : {}) };
  start('gate', wranglerBin, [...gate.argv, ...vars(gateVars), '--inspector-port', String(GATE_PORT + 2442)]);
  if (FAST) say(`gate vars: ${Object.entries(gateVars).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  await waitFor('stub', async () => (await probe(`http://127.0.0.1:${STUB_PORT}/__admin/health`)) === 200);
  await waitFor('control', async () => (await probe(`${APP_ORIGIN}/health`)) === 200);
  await waitFor('gate', async () => (await probe(`http://run.localhost:${GATE_PORT}/`)) === 301);

  say('');
  say(`control plane  ${APP_ORIGIN}`);
  say(`instances      http://<slug>.run.localhost:${GATE_PORT}`);
  say(`stub admin     http://127.0.0.1:${STUB_PORT}/__admin/instances`);
  say(`mail           ${APP_ORIGIN}/__dev/mail?to=<email>`);
  say(`e2e            ${FAST ? 'E2E_FAST=1 ' : ''}npm run test:e2e`);
  say('ready. Ctrl-C stops everything.');
}

main().catch((e) => {
  say(`error: ${e.message}`);
  shutdown(1);
});

// Where the local stack listens, and a check that it is up. Ports: CONTROL_PORT, GATE_PORT and
// STUB_PORT, the same variables `npm run dev` reads; the hostnames are fixed by wrangler config.
import { readFileSync, existsSync } from 'node:fs';
import { request } from './http.mjs';

export const CONTROL_PORT = Number(process.env.CONTROL_PORT || 8787);
export const GATE_PORT = Number(process.env.GATE_PORT || 8798);
export const STUB_PORT = Number(process.env.STUB_PORT || 9100);
/** E2E_APP_ORIGIN targets a deployed control plane instead (test/smoke). */
export const APP_ORIGIN = (process.env.E2E_APP_ORIGIN || `http://app.localhost:${CONTROL_PORT}`).replace(/\/$/, '');
export const APP_HOST = new URL(APP_ORIGIN).host;
export const INSTANCE_DOMAIN = 'run.localhost';
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;
/** E2E_FAST=1: the stack was started with short gate timers (scripts/dev.mjs). */
export const FAST = process.env.E2E_FAST === '1';
export const PASS_SECONDS = Number(process.env.E2E_PASS_SECONDS || (FAST ? 5 : 60));
export const IDLE_SECONDS = Number(process.env.E2E_IDLE_SECONDS || (FAST ? 20 : 86_400));

export const instanceOrigin = (host) => `http://${host}:${GATE_PORT}`;

let devVars = null;
/** .dev.vars (or the file named by E2E_VARS_FILE) as an object (SETUP_TOKEN etc.). */
export function readDevVars() {
  if (devVars) return devVars;
  const path = process.env.E2E_VARS_FILE || new URL('../../../.dev.vars', import.meta.url);
  devVars = {};
  if (!existsSync(path)) return devVars;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    devVars[m[1]] = v;
  }
  return devVars;
}

let upCache = null;
/**
 * Null when the stack answers, else a reason. Control: GET /health 200. Gate: the bare instance
 * domain answers 301 (D67), so another server on the port isn't taken for the gate.
 * Stub: GET /__admin/health 200.
 */
export async function stackDownReason() {
  if (upCache) return upCache.reason;
  const probes = [
    ['control', `${APP_ORIGIN}/health`, (s) => s === 200],
    ['gate', `http://${INSTANCE_DOMAIN}:${GATE_PORT}/`, (s) => s === 301],
    ['stub', `${STUB_ORIGIN}/__admin/health`, (s) => s === 200],
  ];
  const problems = [];
  for (const [name, url, ok] of probes) {
    try {
      const res = await request(url, { timeoutMs: 3000 });
      if (!ok(res.status)) problems.push(`${name} answered ${res.status} at ${url}`);
    } catch (e) {
      problems.push(`${name} not reachable at ${url} (${e.code || e.message})`);
    }
  }
  const reason = problems.length ? `local stack is not up (start it with \`npm run dev\`): ${problems.join('; ')}` : null;
  upCache = { reason };
  return reason;
}

/**
 * For the top of each suite: `const skip = await skipUnlessUp();` then `describe(..., { skip }, ...)`;
 * the reason shows in the test output.
 */
export async function skipUnlessUp({ needFast = false } = {}) {
  const reason = await stackDownReason();
  if (reason) return reason;
  if (needFast && !FAST) return 'needs E2E_FAST=1 for both `npm run dev` and the tests (short idle and pass timers)';
  return false;
}

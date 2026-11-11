// Tunables of the gate, read from optional vars with defaults, and the gate object lookup.
import type { Env } from './env';
import type { GateObject } from './gate-object';

/** Optional vars not (yet) declared in env.ts; all have defaults. */
type OptionalVars = {
  IDLE_SECONDS?: string; // D27: 24 h without a visit
  RECHECK_SECONDS?: string; // D27: retry an hour later when not suspendable
  SCHEDULE_WAKE_LEAD_SECONDS?: string; // D56: wake 10 min before a scheduled run
  UPSTREAM_PAGE_TIMEOUT_SECONDS?: string; // page loads and WebSocket handshakes: headers within 10 s
  UPSTREAM_TIMEOUT_SECONDS?: string; // everything else (API calls, long polls): headers within 90 s
};

function seconds(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function passSeconds(env: Env): number {
  return seconds(env.PASS_SECONDS, 60);
}

export function alarmSettings(env: Env): { idle: number; recheck: number; wakeLead: number } {
  const vars = env as Env & OptionalVars;
  return {
    idle: seconds(vars.IDLE_SECONDS, 86_400),
    recheck: seconds(vars.RECHECK_SECONDS, 3_600),
    wakeLead: seconds(vars.SCHEDULE_WAKE_LEAD_SECONDS, 600),
  };
}

/**
 * How long the gate waits for the instance's response headers (never for the body, so streamed
 * and long-running downloads are unaffected). Page loads and WebSocket handshakes answer at once
 * when worca is up; other requests may legitimately hold their headers (long polls), so they get
 * longer, still under Cloudflare's own 100 s origin limit.
 */
export function upstreamTimeouts(env: Env): { page: number; other: number } {
  const vars = env as Env & OptionalVars;
  return {
    page: seconds(vars.UPSTREAM_PAGE_TIMEOUT_SECONDS, 10),
    other: seconds(vars.UPSTREAM_TIMEOUT_SECONDS, 90),
  };
}

export function isLocalDev(env: Env): boolean {
  return env.LOCAL_DEV === '1';
}

/** The instance's gate object; EU jurisdiction in production (D43, D6). */
export function gateStub(env: Env, instanceId: string): DurableObjectStub<GateObject> {
  const ns = namespaceFor(env, env.GATE_OBJECT as DurableObjectNamespace<GateObject>);
  return ns.get(ns.idFromName(instanceId));
}

function namespaceFor(env: Env, ns: DurableObjectNamespace<GateObject>): DurableObjectNamespace<GateObject> {
  if (isLocalDev(env) || typeof ns.jurisdiction !== 'function') return ns;
  try {
    return ns.jurisdiction('eu');
  } catch {
    return ns; // local runtimes without jurisdiction support
  }
}

// Shared setup for the gate tests: an instance per test, a scripted control plane, a recording
// upstream, and helpers to sign in or mint cookies directly.
import { createExecutionContext, env as testEnv } from 'cloudflare:test';
import { GATE_PATHS, type ControlRpcApi, type HostEntry, type InstanceStatus } from '../../../packages/platform/src/shared/contracts';
import type { Env } from '../../../packages/platform/src/gate/env';
import { gateStub } from '../../../packages/platform/src/gate/config';
import { SESSION_COOKIE, type GateCookie, getCookie, openSession, sealSession } from '../../../packages/platform/src/gate/cookie';
import { setUpstreamFetch } from '../../../packages/platform/src/gate/forward';
import { handleRequest } from '../../../packages/platform/src/gate/handler';

export const env = testEnv as unknown as Env;

type FakeControl = ControlRpcApi & {
  script(s: { codes?: Record<string, unknown>; renew?: unknown }): Promise<void>;
  calls(): Promise<unknown[][]>;
};
export const control = env.CONTROL as unknown as FakeControl;

let counter = 0;

export interface Instance {
  host: string;
  instanceId: string;
  origin: string;
  url: (path?: string) => string;
}

export async function newInstance(status: InstanceStatus | null = 'running'): Promise<Instance> {
  counter += 1;
  const slug = `t${Date.now().toString(36)}${counter}`;
  const host = `${slug}.${env.INSTANCE_DOMAIN}`;
  const instanceId = `inst-${slug}`;
  const entry: HostEntry = { instanceId, kind: 'worca', upstream: 'http://127.0.0.1:9100' };
  await env.HOSTS.put(host, JSON.stringify(entry));
  if (status) await gateStub(env, instanceId).setStatus(instanceId, status);
  await control.script({});
  return { host, instanceId, origin: `http://${host}`, url: (path = '/') => `http://${host}${path}` };
}

export function stub(inst: Instance) {
  return gateStub(env, inst.instanceId);
}

/** Calls the handler directly so tests can override vars. */
export async function gate(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  return handleRequest(request, { ...env, ...overrides } as Env, createExecutionContext());
}

export interface Upstream {
  requests: Request[];
  bodies: string[];
  respond: (req: Request) => Response | Promise<Response>;
}

/** Replaces outbound fetch with a recorder that answers 200 JSON unless told otherwise. */
export function mockUpstream(): Upstream {
  const up: Upstream = {
    requests: [],
    bodies: [],
    respond: () => new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }),
  };
  setUpstreamFetch(async (req) => {
    up.requests.push(req);
    up.bodies.push(req.body ? await req.text() : '');
    return up.respond(req);
  });
  return up;
}

export const now = () => Math.floor(Date.now() / 1000);

export async function mintCookie(inst: Instance, sid: string, patch: Partial<GateCookie> = {}): Promise<string> {
  const c: GateCookie = {
    v: 1, sid, inst: inst.instanceId, uid: 'user-1', passExp: now() + 60, token: 'tok-1', tokenExp: now() + 600, ...patch,
  };
  return `${SESSION_COOKIE}=${await sealSession(env.GATE_COOKIE_KEY, inst.host, c)}`;
}

export async function readSetCookie(inst: Instance, res: Response): Promise<GateCookie | null> {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
  if (!line) return null;
  const value = getCookie(line.split(';')[0]!, SESSION_COOKIE);
  return value ? openSession(env.GATE_COOKIE_KEY, inst.host, value) : null;
}

/** Full round trip: redirect, scripted code, callback. Returns the session cookie pair. */
export async function signIn(inst: Instance, opts: { userId?: string; cpSessionId?: string; tokenExp?: number; returnPath?: string } = {}) {
  const first = await gate(new Request(inst.url(opts.returnPath ?? '/'), { headers: { 'sec-fetch-mode': 'navigate' } }));
  const location = new URL(first.headers.get('location')!);
  const state = location.searchParams.get('state')!;
  const stateCookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
  const code = `code-${Math.random().toString(36).slice(2)}`;
  const userId = opts.userId ?? 'user-1';
  const cpSessionId = opts.cpSessionId ?? 'cps-1';
  await control.script({
    codes: { [code]: { host: inst.host, token: 'tok-1', tokenExp: opts.tokenExp ?? now() + 600, userId, cpSessionId, instanceId: inst.instanceId } },
  });
  const cb = await gate(new Request(inst.url(`${GATE_PATHS.callback}?code=${code}&state=${state}`), { headers: { cookie: stateCookie } }));
  const cookie = cb.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
  const parsed = (await openSession(env.GATE_COOKIE_KEY, inst.host, cookie.slice(SESSION_COOKIE.length + 1)))!;
  return { cookie, sid: parsed.sid, parsed, callback: cb };
}

export function sameOrigin(inst: Instance, init: RequestInit & { headers?: Record<string, string> } = {}): RequestInit {
  return { ...init, headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', ...(init.headers ?? {}) } };
}

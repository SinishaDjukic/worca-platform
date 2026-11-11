// The gate: every request to *.INSTANCE_DOMAIN (architecture.md "Each request after that", security.md
// "Isolation between instances"). Order: host, cookie sanity, callback, cross-origin check, pass,
// gate object check, token renewal, forward.
import { GATE_PATHS, type HostEntry, type WakePhase } from '../shared/contracts';
import type { CheckResult, GateObject, GateStatus } from './gate-object';
import { gateStub, isLocalDev, passSeconds } from './config';
import { SESSION_COOKIE, type GateCookie, clearCookieHeader, getCookie, openSession, sealSession, setCookieHeader } from './cookie';
import { isNavigation, isSameOriginRequest, isUnsafeMethod, isWebSocketUpgrade } from './csrf';
import type { Env } from './env';
import { forward } from './forward';
import { cookieHeaderBroken, secured } from './headers';
import {
  creatingPage, errorPage, jsonResponse, notFoundPage, recoveryPage, signedOutPage, startingPage, stoppedPage, upgradingPage,
} from './pages';
import { siteOf } from '../shared/site';
import { handleCallback, isGatePath, nowSeconds, signInRequired } from './signin';

/** Renew the identity token when less than this is left (architecture.md). */
const RENEW_BEFORE_SECONDS = 120;

export async function handleRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  let res: Response;
  try {
    res = apexRedirect(request, env) ?? (await route(request, env));
  } catch (err) {
    console.error('gate request failed', err);
    res = errorPage(siteOf(env), 502, 'The instance could not be reached. Try again in a moment.');
  }
  if (res.webSocket || res.status === 101) return res;
  return secured(res, env);
}

function requestHost(request: Request): string {
  const raw = request.headers.get('host') ?? new URL(request.url).host;
  return raw.replace(/:\d+$/, '').toLowerCase();
}

/**
 * D67: INSTANCE_DOMAIN and www.INSTANCE_DOMAIN (the gate's custom domains) answer 301 to
 * APEX_REDIRECT_URL, else the deployment's about page (Site.aboutUrl), before anything else;
 * path and query are dropped. `www` is a reserved slug (D10), so no
 * instance can live there.
 */
export function apexRedirect(request: Request, env: Env): Response | null {
  const host = requestHost(request);
  if (host !== env.INSTANCE_DOMAIN && host !== `www.${env.INSTANCE_DOMAIN}`) return null;
  const location = env.APEX_REDIRECT_URL || siteOf(env).aboutUrl;
  return new Response(null, { status: 301, headers: { location, 'cache-control': 'public, max-age=3600' } });
}

/** Hostname without port; null unless exactly one label under INSTANCE_DOMAIN (D8). */
export function instanceHost(request: Request, env: Env): string | null {
  const host = requestHost(request);
  const suffix = `.${env.INSTANCE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return /^[a-z0-9-]+$/.test(label) && label !== 'www' ? host : null;
}

/**
 * worca reads that return stored secrets (the raw model env, API keys included). The pass would let
 * them through for up to PASS_SECONDS after access ends, so they always ask the gate object.
 * Matched like Express does: case-insensitive, optional trailing slash, on the decoded path.
 */
const SECRET_READS = [/^\/api\/models\/[^/]+\/env-value\/?$/i];

export function isSecretRead(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true; // undecodable: don't let it skip the check
  }
  return SECRET_READS.some((re) => re.test(pathname) || re.test(path));
}

async function lookupHost(env: Env, host: string): Promise<HostEntry | null> {
  return env.HOSTS.get<HostEntry>(host, 'json');
}

async function route(request: Request, env: Env): Promise<Response> {
  const host = instanceHost(request, env);
  const notFound = () => notFoundPage(siteOf(env), { host, appOrigin: env.APP_ORIGIN });
  if (!host) return notFound();
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeaderBroken(cookieHeader)) return recoveryPage(siteOf(env));

  const url = new URL(request.url);
  if (url.pathname === GATE_PATHS.callback) return handleCallback(request, env, host, await lookupHost(env, host));

  const ws = isWebSocketUpgrade(request);
  if ((isUnsafeMethod(request.method) || ws) && !isSameOriginRequest(request)) {
    return jsonResponse(403, { error: 'cross_origin' });
  }

  const sealed = getCookie(cookieHeader, SESSION_COOKIE);
  const cookie = sealed ? await openSession(env.GATE_COOKIE_KEY, host, sealed) : null;
  const now = nowSeconds();

  // D44: a read with a live pass goes through without asking the gate object; reads that return
  // secrets are checked every time.
  if (
    cookie && cookie.passExp > now && !ws && !isGatePath(url.pathname) && !isSecretRead(url.pathname) &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    const entry = isLocalDev(env) ? await lookupHost(env, host) : null; // only for its upstream
    if (isLocalDev(env) && entry?.instanceId !== cookie.inst) return notFound();
    return forward(request, host, entry, cookie.token, env);
  }

  const entry = await lookupHost(env, host);
  if (!entry) return notFound();
  const stub = gateStub(env, entry.instanceId);

  if (url.pathname === GATE_PATHS.signout) return signOut(request, env, cookie, entry, stub);
  if (!cookie || cookie.inst !== entry.instanceId) return signInRequired(request, env, host, false);

  const result = await stub.check(cookie.sid);
  if (!result.session) return signInRequired(request, env, host, true);
  if (url.pathname === GATE_PATHS.status) return jsonResponse(200, await statusBody(env, entry, result.status));
  if (isGatePath(url.pathname)) return jsonResponse(404, { error: 'not_found' });
  if (!result.ok) return notRunning(request, env, host, result.status, entry, stub);

  return checkedForward(request, env, host, entry, cookie, result, stub);
}

/** The gate object said yes: renew the token if it is close to expiry, forward, re-issue the pass. */
async function checkedForward(
  request: Request, env: Env, host: string, entry: HostEntry, cookie: GateCookie, result: CheckResult,
  stub: DurableObjectStub<GateObject>,
): Promise<Response> {
  const now = nowSeconds();
  let { token, tokenExp } = cookie;
  if (tokenExp - now < RENEW_BEFORE_SECONDS) {
    const renewed = await renew(env, host, result, tokenExp - now);
    if (renewed === 'gone') {
      await stub.dropSession(cookie.sid);
      return signInRequired(request, env, host, true);
    }
    if (renewed === 'unavailable') return jsonResponse(503, { error: 'control_plane_unavailable' }, { headers: { 'retry-after': '5' } });
    if (renewed) ({ token, tokenExp } = renewed);
  }
  const next: GateCookie = { ...cookie, passExp: now + passSeconds(env), token, tokenExp };
  const res = await forward(request, host, entry, token, env);
  if (res.webSocket || res.status === 101) return res;
  res.headers.append('set-cookie', setCookieHeader(SESSION_COOKIE, await sealSession(env.GATE_COOKIE_KEY, host, next)));
  return res;
}

/** D45. 'gone' = access ended; 'unavailable' = control plane down and the token has run out. */
async function renew(
  env: Env, host: string, result: CheckResult, secondsLeft: number,
): Promise<{ token: string; tokenExp: number } | 'gone' | 'unavailable' | null> {
  const session = result.session!;
  try {
    const renewed = await env.CONTROL.renewToken({ cpSessionId: session.cpSessionId, userId: session.userId, host });
    return renewed ?? 'gone';
  } catch (err) {
    console.error('token renewal failed', err);
    return secondsLeft > 5 ? null : 'unavailable'; // keep the current token while it lasts
  }
}

/** GATE_PATHS.status: the status, and while suspended the wake's phase (G1) from the control plane. */
async function statusBody(env: Env, entry: HostEntry, status: GateStatus): Promise<{ status: GateStatus; phase?: WakePhase | null }> {
  if (status !== 'suspended') return { status };
  try {
    return { status, phase: await env.CONTROL.wakePhase(entry.instanceId) };
  } catch (err) {
    console.error('wake phase unavailable', err);
    return { status, phase: null };
  }
}

/** Status handling (D47): only `suspended` wakes; `stopped` never does. */
async function notRunning(request: Request, env: Env, host: string, status: GateStatus, entry: HostEntry, stub: DurableObjectStub<GateObject>): Promise<Response> {
  const nav = isNavigation(request);
  switch (status) {
    case 'suspended':
      await stub.startWake(entry.instanceId, 'visit');
      return nav ? startingPage(siteOf(env)) : jsonResponse(503, { error: 'instance_starting', status }, { headers: { 'retry-after': '5' } });
    case 'stopped':
      return nav ? stoppedPage(siteOf(env)) : jsonResponse(403, { error: 'instance_stopped', status });
    case 'upgrading':
      return nav ? upgradingPage(siteOf(env)) : jsonResponse(503, { error: 'instance_upgrading', status });
    case 'creating':
      return nav ? creatingPage(siteOf(env)) : jsonResponse(503, { error: 'instance_creating', status });
    default:
      return nav ? notFoundPage(siteOf(env), { host, appOrigin: env.APP_ORIGIN }) : jsonResponse(404, { error: 'not_found', status });
  }
}

/** GATE_PATHS.signout: drop this gate session and the cookie. POSTs passed the same-origin check. */
async function signOut(
  request: Request, env: Env, cookie: GateCookie | null, entry: HostEntry, stub: DurableObjectStub<GateObject>,
): Promise<Response> {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return jsonResponse(403, { error: 'cross_origin' });
  if (cookie && cookie.inst === entry.instanceId) await stub.dropSession(cookie.sid);
  const headers = { 'set-cookie': clearCookieHeader(SESSION_COOKIE) };
  return isNavigation(request) ? signedOutPage(siteOf(env), headers) : new Response(null, { status: 204, headers });
}

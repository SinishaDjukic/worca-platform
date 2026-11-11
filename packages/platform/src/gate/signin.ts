// The sign-in round trip (architecture.md, "Signing in to an instance"): redirect to the control
// plane with a state cookie, then the callback exchanges the one-time code for a gate session.
import type { HostEntry } from '../shared/contracts';
import { gateStub, passSeconds } from './config';
import {
  SESSION_COOKIE, STATE_COOKIE, STATE_SECONDS, clearCookieHeader, getCookie, openState, randomId,
  safeReturnPath, sealSession, sealState, setCookieHeader,
} from './cookie';
import type { Env } from './env';
import { isNavigation } from './csrf';
import { errorPage, jsonResponse } from './pages';
import { siteOf } from '../shared/site';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Navigation: state cookie + redirect to APP_ORIGIN/authorize. Anything else: 401 (W6). */
export async function signInRequired(request: Request, env: Env, host: string, clearSession: boolean): Promise<Response> {
  const headers = new Headers();
  if (clearSession) headers.append('set-cookie', clearCookieHeader(SESSION_COOKIE));
  if (!isNavigation(request)) {
    return jsonResponse(401, { error: 'signin_required' }, { headers });
  }
  const url = new URL(request.url);
  const state = randomId(24);
  const ret = safeReturnPath(url.pathname + url.search);
  const sealed = await sealState(env.GATE_COOKIE_KEY, host, { v: 1, state, ret, exp: nowSeconds() + STATE_SECONDS });
  headers.append('set-cookie', setCookieHeader(STATE_COOKIE, sealed, STATE_SECONDS));
  const authorize = new URL('/authorize', env.APP_ORIGIN);
  authorize.searchParams.set('host', host);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('return', ret);
  headers.set('location', authorize.toString());
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
}

function callbackFailed(env: Env, message: string): Response {
  const res = errorPage(siteOf(env), 400, message);
  res.headers.append('set-cookie', clearCookieHeader(STATE_COOKIE));
  return res;
}

/** GATE_PATHS.callback: state must match the cookie (security.md, last row); code is single-use. */
export async function handleCallback(request: Request, env: Env, host: string, entry: HostEntry | null): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const sealed = getCookie(request.headers.get('cookie'), STATE_COOKIE);
  const saved = sealed ? await openState(env.GATE_COOKIE_KEY, host, sealed, nowSeconds()) : null;
  if (!code || !state || !saved || saved.state !== state) {
    return callbackFailed(env, 'This sign-in link is not valid any more. Open the instance again to sign in.');
  }
  if (!entry) return callbackFailed(env, 'There is no instance at this address.');
  const exchange = await env.CONTROL.exchangeCode(code, host);
  if (!exchange || exchange.instanceId !== entry.instanceId) {
    return callbackFailed(env, 'Signing in did not complete. Open the instance again to try once more.');
  }
  const { sid, status } = await gateStub(env, entry.instanceId).createSession(entry.instanceId, exchange.userId, exchange.cpSessionId);
  // Not running: no pass, so the next request asks the gate object and gets the status page.
  const passExp = status === 'running' ? nowSeconds() + passSeconds(env) : 0;
  const cookie = await sealSession(env.GATE_COOKIE_KEY, host, {
    v: 1, sid, inst: entry.instanceId, uid: exchange.userId, passExp, token: exchange.token, tokenExp: exchange.tokenExp,
  });
  const headers = new Headers({ location: safeReturnPath(saved.ret), 'cache-control': 'no-store' });
  headers.append('set-cookie', setCookieHeader(SESSION_COOKIE, cookie));
  headers.append('set-cookie', clearCookieHeader(STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

export function isGatePath(pathname: string): boolean {
  return pathname.startsWith('/.gate/');
}

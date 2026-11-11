// Header rules that keep instances apart while INSTANCE_DOMAIN is not on the Public Suffix List
// (D12, security.md "Isolation between instances").
import { IDENTITY_HEADER } from '../shared/contracts';
import { SESSION_COOKIE, STATE_COOKIE, parseCookies } from './cookie';
import type { Env } from './env';
import { isLocalDev } from './config';

/** Above this the request is treated as a cookie flood (security.md, "Low" row). */
export const MAX_COOKIE_HEADER = 8192;

const OWN_COOKIES = new Set([SESSION_COOKIE, STATE_COOKIE]);

/** True when the Cookie header is too large or not parseable as name=value pairs. */
export function cookieHeaderBroken(header: string | null): boolean {
  if (!header) return false;
  if (header.length > MAX_COOKIE_HEADER) return true;
  return header.split(';').some((part) => part.trim() !== '' && !/^[^=\s]+=/.test(part.trim()));
}

/** Only `__Host-` cookies reach the instance, never the gate's own (they can't be planted by A on B). */
export function forwardedCookies(header: string | null): string | null {
  const kept = parseCookies(header).filter(([name]) => name.startsWith('__Host-') && !OWN_COOKIES.has(name));
  return kept.length ? kept.map(([n, v]) => `${n}=${v}`).join('; ') : null;
}

/** Request headers for the instance: no client identity header, no gate cookies, our token. */
export function upstreamHeaders(incoming: Headers, host: string, token: string): Headers {
  const headers = new Headers(incoming);
  headers.delete(IDENTITY_HEADER);
  headers.delete('cookie');
  const cookies = forwardedCookies(incoming.get('cookie'));
  if (cookies) headers.set('cookie', cookies);
  headers.set(IDENTITY_HEADER, token);
  headers.set('x-forwarded-host', host);
  return headers;
}

/** Drops instance Set-Cookies that aren't `__Host-`, and any that would overwrite the gate's own. */
export function filterSetCookies(headers: Headers): void {
  const all = headers.getSetCookie();
  if (!all.length) return;
  headers.delete('set-cookie');
  for (const line of all) {
    const name = line.slice(0, Math.max(0, line.indexOf('='))).trim();
    if (name.startsWith('__Host-') && !OWN_COOKIES.has(name)) headers.append('set-cookie', line);
  }
}

/** Headers on every gate response, including proxied ones. */
export function applySecurityHeaders(headers: Headers, env: Env): void {
  // Appended: browsers enforce every CSP header, so worca's own policy stays in force.
  headers.append('content-security-policy', "frame-ancestors 'none'");
  headers.set('x-frame-options', 'DENY');
  headers.set('origin-agent-cluster', '?1');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  if (!isLocalDev(env)) headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
}

/** A copy of `res` with mutable headers and the security headers applied. */
export function secured(res: Response, env: Env): Response {
  const out = new Response(res.body, res);
  applySecurityHeaders(out.headers, env);
  return out;
}

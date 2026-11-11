// Request plumbing for every control-plane request: request id, HTTPS, security headers,
// Origin check, session, rate limits, Turnstile.
import type { Context, MiddlewareHandler } from 'hono';
import { featureGate } from '../features';
import type { AppContext, Env, SessionInfo, SessionUser } from '../env';
import { getAuth } from './index';
import { rateLimit } from './rate-limit';
import { turnstileGuard } from './turnstile';
import { publicFormOrigins } from '../public';

const requestId: MiddlewareHandler<AppContext> = async (c, next) => {
  const id = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', id);
  c.set('user', null);
  c.set('session', null);
  await next();
  c.res.headers.set('x-request-id', id);
};

// wrangler dev serves plain http and can't be told apart by hostname, hence LOCAL_DEV.
const httpsOnly: MiddlewareHandler<AppContext> = async (c, next) => {
  const url = new URL(c.req.url);
  if (url.protocol === 'http:' && c.env.LOCAL_DEV !== '1') {
    url.protocol = 'https:';
    return c.redirect(url.toString(), 301);
  }
  return next();
};

/** Applied to HTML responses that don't set their own CSP. Pages use same-origin scripts only. */
export const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const securityHeaders: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.env.LOCAL_DEV !== '1') res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.headers.set('X-Frame-Options', 'DENY');
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    if (!res.headers.has('Content-Security-Policy')) res.headers.set('Content-Security-Policy', PAGE_CSP);
    res.headers.set('Cache-Control', 'no-store');
  }
  c.res = res;
};

/** Origins allowed to send state-changing requests (security.md "Domain isolation"). */
export function isTrustedOrigin(env: Env, origin: string): boolean {
  if (origin === new URL(env.APP_ORIGIN).origin) return true;
  if (env.LOCAL_DEV !== '1') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

// Better Auth checks its own routes (trustedOrigins), and SAML responses arrive cross-site by
// design. Requests without Origin are non-browser clients (the gate, instances, curl): browsers
// always send Origin on a cross-origin POST.
const originCheck: MiddlewareHandler<AppContext> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path.startsWith('/api/auth/')) return next();
  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  // The website's forms (public/index.ts) post cross-site, from these origins only.
  if (c.req.path.startsWith('/api/public/') && origin && publicFormOrigins(c.env).includes(origin)) return next();
  if ((origin && origin !== 'null' && !isTrustedOrigin(c.env, origin)) || origin === 'null' || site === 'cross-site') {
    return c.json({ error: 'invalid_origin' }, 403);
  }
  return next();
};

function hasSessionCookie(c: Context<AppContext>): boolean {
  return /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(c.req.header('cookie') ?? '');
}

const session: MiddlewareHandler<AppContext> = async (c, next) => {
  // Better Auth serves /api/auth itself; skipping it there also avoids a second session read.
  if (!hasSessionCookie(c) || c.req.path.startsWith('/api/auth/')) return next();
  const auth = getAuth(c.env);
  const result = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
  const data = result.response;
  if (data) {
    const u = data.user as typeof data.user & { status?: SessionUser['status'] };
    const s = data.session as typeof data.session & { method?: SessionInfo['method']; mfa?: boolean; ssoOrgId?: string | null; activeOrganizationId?: string | null };
    c.set('user', { id: u.id, email: u.email, name: u.name, status: u.status ?? 'pending' });
    c.set('session', {
      id: s.id,
      userId: s.userId,
      method: s.method ?? 'email-otp',
      mfa: s.mfa === true,
      ssoOrgId: s.ssoOrgId ?? null,
      expiresAt: new Date(s.expiresAt).getTime(),
      activeOrganizationId: s.activeOrganizationId ?? null,
    });
  }
  await next();
  // getSession may roll the session forward (updateAge); pass the refreshed cookie on.
  for (const cookie of result.headers?.getSetCookie?.() ?? []) c.res.headers.append('set-cookie', cookie);
};

/** Applied to every request in order: request id, security headers, session, rate limits, Turnstile. */
export const globalMiddleware: MiddlewareHandler<AppContext>[] = [
  requestId,
  httpsOnly,
  securityHeaders,
  originCheck,
  featureGate, // 2.4: a module that is off is 404 before its rate limits and Turnstile apply
  rateLimit(),
  turnstileGuard(),
  session,
];

/** A page navigation (rather than fetch/XHR), which gets a redirect instead of a 401. */
function isNavigation(c: Context<AppContext>): boolean {
  if (c.req.method !== 'GET') return false;
  const mode = c.req.header('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (c.req.header('accept') ?? '').includes('text/html');
}

/** 401 unless signed in with an active account (403 for pending or disabled accounts). */
export const requireSession: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || !c.get('session')) {
    if (isNavigation(c)) {
      const url = new URL(c.req.url);
      return c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (user.status !== 'active') return c.json({ error: user.status === 'pending' ? 'account_pending' : 'account_disabled' }, 403);
  return next();
};

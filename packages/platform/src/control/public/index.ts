// Public, unauthenticated endpoints under /api/public, called cross-site from the operator's
// website (PUBLIC_FORM_ORIGINS) as well as from the app's own pages. CORS is answered here;
// the Origin check in auth/middleware.ts lets these origins through for /api/public/* only.
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../env';
import { accessRequestsPublicApp } from './access-requests';
import { newsletterPublicApp } from './newsletter';

/** Origins of the website forms, from the comma-separated PUBLIC_FORM_ORIGINS var. */
export function publicFormOrigins(env: Env): string[] {
  return (env.PUBLIC_FORM_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const cors: MiddlewareHandler<AppContext> = async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = origin && publicFormOrigins(c.env).includes(origin) ? origin : null;
  if (c.req.method === 'OPTIONS') {
    if (!allowed) return c.body(null, 204);
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-turnstile-token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    });
  }
  await next();
  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', allowed);
    c.res.headers.append('Vary', 'Origin');
  }
};

export const publicApp = new Hono<AppContext>();
publicApp.use('*', cors);
publicApp.route('/access-requests', accessRequestsPublicApp);
publicApp.route('/newsletter', newsletterPublicApp);

// Fixed-window per-IP rate limits on credential endpoints.
// KV counts are approximate under concurrency, which is fine for a brute-force deterrent.
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../env';

export interface Limit {
  limit: number;
  windowS: number;
}

export const RATE_LIMITS: Record<string, Limit> = {
  '/api/auth/email-otp/send-verification-otp': { limit: 5, windowS: 900 },
  '/api/auth/sign-in/email-otp': { limit: 10, windowS: 300 },
  '/api/auth/passkey/verify-authentication': { limit: 20, windowS: 300 },
  '/api/auth/sign-in/social': { limit: 20, windowS: 300 },
  '/api/auth/sign-in/sso': { limit: 20, windowS: 300 },
  '/api/setup': { limit: 5, windowS: 900 },
  // The website's access-request form (D69) and its confirmation page.
  '/api/public/access-requests': { limit: 5, windowS: 3600 },
  '/api/public/access-requests/confirm': { limit: 20, windowS: 3600 },
  // Newsletter (D70): the two that send mail, and the confirm step.
  '/api/public/newsletter/subscribe': { limit: 10, windowS: 900 },
  '/api/public/newsletter/link': { limit: 5, windowS: 900 },
  '/api/public/newsletter/confirm': { limit: 20, windowS: 900 },
};

export function rateLimit(limits: Record<string, Limit> = RATE_LIMITS): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const conf = limits[c.req.path];
    const ip = c.req.header('cf-connecting-ip');
    // Local dev runs the e2e suites from one address.
    if (!conf || !ip || c.env.LOCAL_DEV === '1') return next();
    const windowId = Math.floor(Date.now() / (conf.windowS * 1000));
    const key = `rl:${c.req.path}:${ip}:${windowId}`;
    const count = parseInt((await c.env.KV.get(key)) ?? '0', 10) + 1;
    if (count > conf.limit) {
      const minutes = Math.round(conf.windowS / 60);
      // Both keys: our callers read `error`, the Better Auth client shows `message`.
      return c.json({ error: 'rate_limited', message: `Too many attempts. Wait ${minutes} minutes and try again.` }, 429, {
        'Retry-After': String(conf.windowS),
      });
    }
    await c.env.KV.put(key, String(count), { expirationTtl: Math.max(60, conf.windowS * 2) });
    return next();
  };
}

// ---- counters for limits that aren't per path and IP (invitation mail, tenancy/routes.ts) -----

/** Current value of a KV counter (0 when absent). Approximate under concurrency, like above. */
export async function readCounter(kv: KVNamespace, key: string): Promise<number> {
  return parseInt((await kv.get(key)) ?? '0', 10) || 0;
}

/** Adds one to a KV counter that expires `ttlS` seconds after its last write (KV minimum 60). */
export async function bumpCounter(kv: KVNamespace, key: string, ttlS: number): Promise<number> {
  const next = (await readCounter(kv, key)) + 1;
  await kv.put(key, String(next), { expirationTtl: Math.max(60, ttlS) });
  return next;
}

/** UTC calendar day, for daily windows: '2026-10-06'. */
export const utcDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

// Turnstile on the POSTs that start a sign-in or sign-up.
// Off when TURNSTILE_SECRET is unset. Clients pass the widget token in x-turnstile-token.
// Only the step that sends mail or leaves for a provider is guarded: tokens are single-use,
// so guarding the code check as well would make people solve the challenge twice.
// The smoke tests sign people up on production without a browser: they send
// TURNSTILE_BYPASS_TOKEN (a separate secret, unset = no bypass) in x-turnstile-bypass instead.
import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from '../crypto';
import type { AppContext } from '../env';

export const TURNSTILE_PATHS = new Set([
  '/api/auth/email-otp/send-verification-otp',
  '/api/auth/sign-in/social',
  '/api/auth/sign-in/sso',
  '/api/public/access-requests', // the website's form sends the token when it shows the widget
  '/api/public/newsletter/subscribe', // D70: both newsletter endpoints that send mail
  '/api/public/newsletter/link',
]);

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string,
  token: string,
  ip: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  try {
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: form });
    const outcome = (await res.json()) as { success?: boolean };
    return outcome.success === true;
  } catch {
    return false;
  }
}

export function turnstileGuard(fetchImpl: typeof fetch = (...a) => fetch(...a)): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const secret = c.env.TURNSTILE_SECRET;
    if (!secret || c.req.method !== 'POST' || !TURNSTILE_PATHS.has(c.req.path)) return next();
    const bypass = c.env.TURNSTILE_BYPASS_TOKEN;
    const given = c.req.header('x-turnstile-bypass');
    if (bypass && bypass.length >= 32 && given && timingSafeEqual(given, bypass)) return next();
    const token = c.req.header('x-turnstile-token');
    if (!token) {
      return c.json({ error: 'turnstile_required', message: 'Complete the verification, then try again.' }, 403);
    }
    if (!(await verifyTurnstile(secret, token, c.req.header('cf-connecting-ip'), fetchImpl))) {
      return c.json({ error: 'turnstile_failed', message: 'Verification expired. Complete it again and retry.' }, 403);
    }
    return next();
  };
}

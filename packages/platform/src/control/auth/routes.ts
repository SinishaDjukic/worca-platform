// Better Auth's routes, the sign-in / sign-out / invitation pages, the first-superadmin
// bootstrap and the local mail viewer.
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { getAuth } from './index';
import { readDevMail } from './email';
import { SIGN_IN_JS, SIGN_IN_JS_PATH, invitePage, messagePage, signInPage, signOutPage } from './pages';
import { getRegistrationMode } from './registration';
import { auditPlatform } from '../tenancy/audit';
import { siteOf } from '../../shared/site';

export const authApp = new Hono<AppContext>();

// ---- Better Auth --------------------------------------------------------------------------

/**
 * Better Auth endpoints reachable over HTTP; everything else is 404. Plugin mutations (org,
 * member, team, invitation management, account deletion, session revocation) bypass the tenancy
 * guards (last tenant admin, MFA, D30 confirmations, audit, gate session drops), so tenancy
 * calls them server-side through auth.api.*, which never passes through here.
 */
const PUBLIC_AUTH_ROUTES: (string | RegExp)[] = [
  // sessions and email codes
  '/get-session',
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  // Google / Microsoft
  '/sign-in/social',
  /^\/callback\/[^/]+$/,
  '/link-social',
  '/list-accounts',
  '/unlink-account',
  '/update-user', // name and image only; status and the other fields are input: false
  // passkeys
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
  // org SSO: sign-in, IdP callbacks and SP metadata only. Providers are created, changed and
  // domain-verified only through the tenancy endpoints, which call auth.api server-side.
  '/sign-in/sso',
  '/sso/callback',
  /^\/sso\/callback\/[^/]+$/,
  /^\/sso\/saml2\/sp\/(acs|slo)\/[^/]+$/,
  '/sso/saml2/sp/metadata',
  // what the invitation page and org switcher need
  '/organization/get-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/list-user-invitations',
  '/organization/list',
  '/organization/set-active',
  '/error',
  '/ok',
];

export function isPublicAuthRoute(path: string): boolean {
  if (!path.startsWith('/api/auth/')) return false;
  const rest = path.slice('/api/auth'.length);
  return PUBLIC_AUTH_ROUTES.some((r) => (typeof r === 'string' ? r === rest : r.test(rest)));
}

authApp.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const path = c.req.path;
  // No admin plugin (D54); seal the prefix anyway so no future plugin can expose it.
  if (path === '/api/auth/admin' || path.startsWith('/api/auth/admin/')) return c.json({ error: 'forbidden' }, 403);
  if (!isPublicAuthRoute(path)) return c.json({ error: 'not_found' }, 404);
  return getAuth(c.env).handler(c.req.raw);
});

// ---- Pages --------------------------------------------------------------------------------

/** Same-origin path only; anything else (absolute, protocol-relative, backslashes) becomes "/". */
export function safeNext(raw: string | undefined | null, appOrigin: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f\\]/.test(raw)) return '/';
  try {
    const origin = new URL(appOrigin).origin;
    const url = new URL(raw, origin);
    if (url.origin !== origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

authApp.get(SIGN_IN_JS_PATH, (c) =>
  c.body(SIGN_IN_JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }),
);

/** D23: `methods` from /authorize, when the instance needs another sign-in method; known names only. */
const METHOD_NAMES = new Set(['email-otp', 'passkey', 'google', 'microsoft', 'sso']);
function requiredMethods(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').filter((m) => METHOD_NAMES.has(m)))];
}

authApp.get('/sign-in', async (c) => {
  const next = safeNext(c.req.query('next'), c.env.APP_ORIGIN);
  const methods = requiredMethods(c.req.query('methods'));
  // Signed in already: straight on, unless an instance asked for another method (D23); then the
  // page asks to sign in again, or /authorize would send the person right back here.
  if (c.get('user') && !methods.length) return c.redirect(next, 302);
  const mode = await getRegistrationMode(c.env);
  const env = c.env;
  return c.html(
    signInPage({
      next,
      google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      microsoft: !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
      mode,
      turnstileSiteKey: env.TURNSTILE_SECRET ? env.TURNSTILE_SITE_KEY : undefined,
      error: c.req.query('error') ? 'Sign-in did not complete. Try again.' : undefined,
      methods,
      site: siteOf(env),
    }),
  );
});

authApp.get('/sign-out', (c) => c.html(signOutPage(siteOf(c.env))));

authApp.post('/sign-out', async (c) => {
  if (c.get('session')) {
    const { headers } = await getAuth(c.env).api.signOut({ headers: c.req.raw.headers, returnHeaders: true });
    const res = c.redirect('/sign-in', 303);
    for (const cookie of headers.getSetCookie()) res.headers.append('set-cookie', cookie);
    return res;
  }
  return c.redirect('/sign-in', 303);
});

function signInFirst(c: Context<AppContext>) {
  const url = new URL(c.req.url);
  return c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname)}`, 302);
}

authApp.get('/invite/:id', async (c) => {
  if (!c.get('user')) return signInFirst(c);
  try {
    const inv = await getAuth(c.env).api.getInvitation({ query: { id: c.req.param('id') }, headers: c.req.raw.headers });
    return c.html(invitePage({ invitationId: inv.id, orgName: inv.organizationName, inviterEmail: inv.inviterEmail, site: siteOf(c.env) }));
  } catch {
    return c.html(messagePage('Invitation not available', 'This invitation is not for this account, has expired, or was already used.', { href: '/', label: 'Continue' }, { glyph: ['alert', 'amber'], site: siteOf(c.env) }), 404);
  }
});

authApp.post('/invite/:id', async (c) => {
  if (!c.get('user')) return signInFirst(c);
  const auth = getAuth(c.env);
  try {
    await auth.api.acceptInvitation({ body: { invitationId: c.req.param('id') }, headers: c.req.raw.headers });
  } catch {
    return c.html(messagePage('Invitation not available', 'This invitation is not for this account, has expired, or was already used.', { href: '/', label: 'Continue' }, { glyph: ['alert', 'amber'], site: siteOf(c.env) }), 404);
  }
  // The tenant vouched for this person: a waitlisted account becomes active on joining, as an
  // invited member, which doesn't let them create their own org (canCreateOrganization, D25).
  const user = c.get('user');
  if (user?.status === 'pending') {
    await (await auth.$context).internalAdapter.updateUser(user.id, { status: 'active', registeredVia: 'invitation' });
  }
  return c.redirect('/', 303);
});

// ---- First superadmin ---------------------------------------------------------------------

const setupBody = z.object({ token: z.string().min(1), email: z.email(), name: z.string().max(200).optional() });

async function tokensEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  // Equal-length digests compared without an early exit.
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * One-time bootstrap of the first superadmin (without a
 * password: that person then signs in with an email code). Refused once any superadmin exists.
 */
authApp.post('/api/setup', async (c) => {
  const parsed = setupBody.safeParse(await c.req.json().catch(() => null));
  if (!c.env.SETUP_TOKEN || !parsed.success || !(await tokensEqual(parsed.data.token, c.env.SETUP_TOKEN))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const existing = await c.env.DB.prepare(`SELECT 1 AS ok FROM platform_roles WHERE role = 'superadmin' LIMIT 1`).first();
  if (existing) return c.json({ error: 'already_initialized' }, 409);

  const ctx = await getAuth(c.env).$context;
  const email = parsed.data.email.trim().toLowerCase();
  const found = await ctx.internalAdapter.findUserByEmail(email);
  let userId: string;
  if (found) {
    userId = found.user.id;
    await ctx.internalAdapter.updateUser(userId, { status: 'active', emailVerified: true });
  } else {
    // Straight through the adapter (still encrypted by the wrapper), bypassing the registration hook.
    const now = new Date();
    const created = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'user',
      data: { email, name: parsed.data.name ?? '', emailVerified: true, status: 'active', registeredVia: 'setup', createdAt: now, updatedAt: now },
    });
    userId = created.id;
  }
  // Conditional insert: two concurrent bootstraps can't both succeed.
  const res = await c.env.DB.prepare(
    `INSERT INTO platform_roles (user_id, role, granted_by, granted_at)
     SELECT ?, 'superadmin', NULL, ? WHERE NOT EXISTS (SELECT 1 FROM platform_roles WHERE role = 'superadmin')`,
  )
    .bind(userId, Date.now())
    .run();
  if (!res.meta.changes) return c.json({ error: 'already_initialized' }, 409);
  await auditPlatform(c.env, {
    actorId: userId,
    actorRole: 'superadmin',
    action: 'platform.bootstrapped',
    targetType: 'user',
    targetId: userId,
    details: {},
  });
  return c.json({ ok: true, userId });
});

// ---- Local mail viewer --------------------------------------------------------------------

authApp.get('/__dev/mail', async (c) => {
  if (c.env.LOCAL_DEV !== '1') throw new HTTPException(404, { message: 'not found' });
  const to = c.req.query('to');
  if (!to) return c.json({ error: 'to required' }, 400);
  return c.json(await readDevMail(c.env, to));
});

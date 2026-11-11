// Decision functions and middleware of src/control/auth in isolation: D50 linking rules, SSO
// trust, org creation, rate limit, Turnstile, headers, requireSession, mail transport.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppContext, Env } from '../../../packages/platform/src/control/env';
import { emailVouched, getAuth, microsoftAccountId, sessionMethodFor, approveWaitlistedUser } from '../../../packages/platform/src/control/auth/index';
import { globalMiddleware, requireSession } from '../../../packages/platform/src/control/auth/middleware';
import { authApp, safeNext } from '../../../packages/platform/src/control/auth/routes';
import { canCreateOrganization, decideRegistration, ssoVouches, type SsoProviderFacts } from '../../../packages/platform/src/control/auth/registration';
import { rateLimit } from '../../../packages/platform/src/control/auth/rate-limit';
import { turnstileGuard, verifyTurnstile } from '../../../packages/platform/src/control/auth/turnstile';
import { actionEmail, noticeEmailHtml, orgInvitationEmail, sendEmail, signInCodeEmail } from '../../../packages/platform/src/control/auth/email';
import { siteOf } from '../../../packages/platform/src/shared/site';

/** The hosted deployment's mail settings (the dev vars carry its branding), on its prod origins. */
const SITE = siteOf({ ...env, APP_ORIGIN: 'https://app.worca.dev', INSTANCE_DOMAIN: 'worca.run' });

const fakeJwt = (claims: Record<string, unknown>) =>
  `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.sig`;

/** The control-plane app as the Worker wires it, against an env of the test's choosing. */
function appWith(overrides: Partial<Env>) {
  const app = new Hono<AppContext>();
  for (const mw of globalMiddleware) app.use('*', mw);
  app.route('/', authApp);
  const e = { ...env, ...overrides } as Env;
  return { app, e };
}

async function setMode(mode: string) {
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(mode)
    .run();
}

describe('D50 account linking', () => {
  it('only a provider-vouched email counts as verified', () => {
    expect(emailVouched('google', { email_verified: true })).toBe(true);
    expect(emailVouched('google', { email_verified: false })).toBe(false);
    expect(emailVouched('google', { email_verified: 'true' })).toBe(false);
    expect(emailVouched('google', {})).toBe(false);
    expect(emailVouched('microsoft', { xms_edov: true })).toBe(true);
    // Microsoft's own email_verified / email claims are never trusted.
    expect(emailVouched('microsoft', { email_verified: true, email: 'a@b.c' })).toBe(false);
    expect(emailVouched('microsoft', { xms_edov: false })).toBe(false);
    expect(emailVouched('github', { email_verified: true })).toBe(false);
  });

  it('identifies Microsoft users by tid + oid', () => {
    expect(microsoftAccountId({ tid: 't1', oid: 'o1', email: 'x@y.z' })).toBe('t1:o1');
    expect(() => microsoftAccountId({ oid: 'o1' })).toThrow();
    expect(() => microsoftAccountId({ tid: 't1', oid: '' })).toThrow();
  });

  it('wires both rules into the providers, and trusts no provider by name', async () => {
    const e = { ...env, GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 'm' } as Env;
    const ctx = await getAuth(e).$context;
    expect(ctx.trustedProviders).toEqual([]);
    // The email code always works, so the last linked provider can be unlinked.
    expect(ctx.options.account?.accountLinking?.allowUnlinkingAll).toBe(true);
    const ms = ctx.socialProviders.find((p) => p.id === 'microsoft')!;
    const google = ctx.socialProviders.find((p) => p.id === 'google')!;
    expect(await ms.accountSubject({ profile: { tid: 'tenant', oid: 'object' }, tokens: {} } as never)).toBe('tenant:object');

    const msUnvouched = await ms.getUserInfo({ idToken: fakeJwt({ oid: 'o', tid: 't', email: 'v@x.com', email_verified: true }) } as never);
    expect(msUnvouched?.user.emailVerified).toBe(false);
    const msVouched = await ms.getUserInfo({ idToken: fakeJwt({ oid: 'o', tid: 't', email: 'v@x.com', xms_edov: true }) } as never);
    expect(msVouched?.user.emailVerified).toBe(true);
    const g = await google.getUserInfo({ idToken: fakeJwt({ sub: 's', email: 'v@x.com', email_verified: true }) } as never);
    expect(g?.user.emailVerified).toBe(true);
  });

  it('refuses to create an account for an unvouched email in every mode', async () => {
    for (const mode of ['invite_code', 'waitlist', 'open']) {
      await setMode(mode);
      await expect(
        decideRegistration(env, { email: 'a@x.com', emailVerified: false, code: null, hasPendingInvitation: async () => true }),
      ).rejects.toMatchObject({ code: 'email_not_verified' });
    }
    await setMode('invite_code');
  });
});

describe('org SSO trust', () => {
  const good: SsoProviderFacts = { organizationId: 'org1', domain: 'Acme.com', domainVerified: true, orgActive: true };

  it('vouches only for an org-owned, active, domain-verified provider on the exact domain', () => {
    expect(ssoVouches(good, 'jo@acme.com')).toBe(true);
    expect(ssoVouches(good, 'jo@evil.com')).toBe(false);
    expect(ssoVouches(good, 'jo@sub.acme.com')).toBe(false);
    expect(ssoVouches(good, 'jo@acme.com.evil.com')).toBe(false);
    expect(ssoVouches({ ...good, domainVerified: false }, 'jo@acme.com')).toBe(false);
    expect(ssoVouches({ ...good, organizationId: null }, 'jo@acme.com')).toBe(false);
    expect(ssoVouches({ ...good, orgActive: false }, 'jo@acme.com')).toBe(false);
    expect(ssoVouches({ ...good, domain: 'acme.com,evil.com' }, 'jo@acme.com')).toBe(false);
  });

  it('auto-activates a vouched SSO user in invite_code mode, nothing else', async () => {
    await setMode('invite_code');
    const base = { emailVerified: true, code: null, hasPendingInvitation: async () => false };
    expect(await decideRegistration(env, { ...base, email: 'jo@acme.com', sso: good })).toMatchObject({ status: 'active', registeredVia: 'sso' });
    await expect(decideRegistration(env, { ...base, email: 'jo@evil.com', sso: good })).rejects.toMatchObject({ code: 'signup_code_required' });
    await expect(
      decideRegistration(env, { ...base, email: 'jo@acme.com', sso: { ...good, domainVerified: false } }),
    ).rejects.toMatchObject({ code: 'signup_code_required' });
    await setMode('waitlist');
    expect(await decideRegistration(env, { ...base, email: 'jo@acme.com', sso: { ...good, domainVerified: false } })).toMatchObject({
      status: 'pending',
    });
    await setMode('invite_code');
  });

  async function provider(fields: { organizationId: string | null; domain: string; domainVerified: boolean }) {
    const ctx = await getAuth(env).$context;
    const providerId = `p-${crypto.randomUUID()}`;
    const owner = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'user',
      data: { email: `${providerId}@owner.test`, name: '', emailVerified: true, status: 'active', createdAt: new Date(), updatedAt: new Date() },
    });
    await ctx.adapter.create({ model: 'ssoProvider', data: { providerId, issuer: 'https://idp.test', userId: owner.id, ...fields } });
    return { providerId, ownerId: owner.id, ctx };
  }

  async function org() {
    const ctx = await getAuth(env).$context;
    return ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'organization',
      data: { name: 'Acme', slug: `acme-${crypto.randomUUID()}`, createdAt: new Date() },
    });
  }

  it('the user hook ignores IdP email_verified on a foreign domain and refuses the account', async () => {
    await setMode('open');
    const o = await org();
    const { providerId, ctx } = await provider({ organizationId: o.id, domain: 'acme.com', domainVerified: true });
    const before = getAuth(env).options.databaseHooks!.user!.create!.before!;
    const hookCtx = { path: '/sso/callback/:providerId', params: { providerId }, context: { adapter: ctx.adapter } } as never;
    const user = { id: 'u', name: '', createdAt: new Date(), updatedAt: new Date(), emailVerified: true };
    await expect(before({ ...user, email: 'mallory@victim.com' }, hookCtx)).rejects.toMatchObject({ statusCode: 403 });
    const ok = (await before({ ...user, email: 'jo@acme.com' }, hookCtx)) as { data: Record<string, unknown> };
    expect(ok.data).toMatchObject({ emailVerified: true, status: 'active', registeredVia: 'sso' });
    await setMode('invite_code');
  });

  it('the user hook does not auto-activate through an unverified or org-less provider', async () => {
    await setMode('invite_code');
    const o = await org();
    const unverified = await provider({ organizationId: o.id, domain: 'acme.com', domainVerified: false });
    const orgless = await provider({ organizationId: null, domain: 'acme.com', domainVerified: true });
    const before = getAuth(env).options.databaseHooks!.user!.create!.before!;
    for (const p of [unverified, orgless]) {
      const hookCtx = { path: '/sso/callback/:providerId', params: { providerId: p.providerId }, context: { adapter: p.ctx.adapter } } as never;
      await expect(
        before({ id: 'u', name: '', createdAt: new Date(), updatedAt: new Date(), emailVerified: true, email: 'jo@acme.com' }, hookCtx),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

describe('org creation (D25)', () => {
  it('follows how the person registered', async () => {
    await setMode('invite_code');
    for (const via of ['code', 'open', 'setup', 'approved']) expect(await canCreateOrganization(env, { status: 'active', registeredVia: via })).toBe(true);
    for (const via of ['invitation', 'sso', 'waitlist', undefined]) expect(await canCreateOrganization(env, { status: 'active', registeredVia: via })).toBe(false);
    expect(await canCreateOrganization(env, { status: 'pending', registeredVia: 'code' })).toBe(false);
    await setMode('open');
    expect(await canCreateOrganization(env, { status: 'active', registeredVia: 'invitation' })).toBe(true);
    expect(await canCreateOrganization(env, { status: 'disabled', registeredVia: 'open' })).toBe(false);
    await setMode('invite_code');
  });

  it('approving a waitlisted user lets them create an org', async () => {
    const ctx = await getAuth(env).$context;
    const u = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'user',
      data: { email: `wl-${crypto.randomUUID()}@x.test`, name: '', emailVerified: true, status: 'pending', registeredVia: 'waitlist', createdAt: new Date(), updatedAt: new Date() },
    });
    expect(await approveWaitlistedUser(env, u.id)).toBe(true);
    expect(await approveWaitlistedUser(env, u.id)).toBe(false);
    const row = await env.DB.prepare(`SELECT status, registeredVia FROM "user" WHERE id = ?`).bind(u.id).first();
    expect(row).toEqual({ status: 'active', registeredVia: 'approved' });
    expect(await canCreateOrganization(env, row as Record<string, unknown>)).toBe(true);
  });
});

describe('session method', () => {
  it('derives the method from the endpoint creating the session', () => {
    expect(sessionMethodFor({ path: '/sign-in/email-otp' })).toBe('email-otp');
    expect(sessionMethodFor({ path: '/passkey/verify-authentication' })).toBe('passkey');
    expect(sessionMethodFor({ path: '/callback/:id', params: { id: 'google' } })).toBe('google');
    expect(sessionMethodFor({ path: '/callback/:id', params: { id: 'microsoft' } })).toBe('microsoft');
    expect(sessionMethodFor({ path: '/sign-in/social', body: { provider: 'google' } })).toBe('google');
    expect(sessionMethodFor({ path: '/sso/callback/:providerId', params: { providerId: 'x' } })).toBe('sso');
    expect(sessionMethodFor({ path: '/sso/saml2/sp/acs/:providerId' })).toBe('sso');
    expect(sessionMethodFor({ path: '/callback/:id', params: { id: 'github' } })).toBe('email-otp');
    expect(sessionMethodFor(undefined)).toBe('email-otp');
  });
});

describe('next parameter', () => {
  it('keeps same-origin paths only', () => {
    const o = 'https://app.worca.dev';
    expect(safeNext('/orgs?x=1#h', o)).toBe('/orgs?x=1#h');
    for (const bad of [undefined, '', 'orgs', 'https://evil.com', '//evil.com', '/\\evil.com', '/%0d%0aLocation:x', '\\/evil.com', 'javascript:x', '/a\\b']) {
      expect(safeNext(bad, o), String(bad)).toBe(bad === '/%0d%0aLocation:x' ? '/%0d%0aLocation:x' : '/');
    }
  });
});

describe('plumbing outside local dev', () => {
  it('redirects http to https and sets HSTS', async () => {
    const { app, e } = appWith({ LOCAL_DEV: undefined });
    const res = await app.request('http://app.worca.dev/sign-in?x=1', {}, e);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://app.worca.dev/sign-in?x=1');
    const page = await app.request('https://app.worca.dev/sign-out', {}, e);
    expect(page.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  it('hides /__dev/mail', async () => {
    const { app, e } = appWith({ LOCAL_DEV: undefined });
    expect((await app.request('https://app.worca.dev/__dev/mail?to=a@b.c', {}, e)).status).toBe(404);
  });

  it('rate-limits credential POSTs per IP with 429', async () => {
    const { app, e } = appWith({ LOCAL_DEV: undefined });
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    const hit = () =>
      app.request('https://app.worca.dev/api/setup', { method: 'POST', headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' }, body: '{}' }, e);
    for (let i = 0; i < 5; i++) expect((await hit()).status).toBe(403);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { message: string }).message).toMatch(/Too many/);
  });

  it('rateLimit leaves other paths and methods alone', async () => {
    const app = new Hono<AppContext>();
    app.use('*', rateLimit({ '/x': { limit: 0, windowS: 60 } }));
    app.all('*', (c) => c.text('ok'));
    const e = { ...env, LOCAL_DEV: undefined } as Env;
    const h = { 'cf-connecting-ip': '198.51.100.1' };
    expect((await app.request('/x', { method: 'GET', headers: h }, e)).status).toBe(200);
    expect((await app.request('/y', { method: 'POST', headers: h }, e)).status).toBe(200);
    expect((await app.request('/x', { method: 'POST', headers: h }, e)).status).toBe(429);
  });
});

describe('Turnstile', () => {
  const path = '/api/auth/email-otp/send-verification-otp';
  function guarded(fetchImpl: typeof fetch) {
    const app = new Hono<AppContext>();
    app.use('*', turnstileGuard(fetchImpl));
    app.all('*', (c) => c.text('ok'));
    return app;
  }
  const ok: typeof fetch = async () => Response.json({ success: true });
  const no: typeof fetch = async () => Response.json({ success: false });

  it('is off without a secret', async () => {
    expect((await guarded(no).request(path, { method: 'POST' }, { ...env, TURNSTILE_SECRET: undefined })).status).toBe(200);
  });

  it('requires a valid token when the secret is set', async () => {
    const e = { ...env, TURNSTILE_SECRET: 's' };
    expect((await guarded(ok).request(path, { method: 'POST' }, e)).status).toBe(403);
    expect((await guarded(no).request(path, { method: 'POST', headers: { 'x-turnstile-token': 't' } }, e)).status).toBe(403);
    expect((await guarded(ok).request(path, { method: 'POST', headers: { 'x-turnstile-token': 't' } }, e)).status).toBe(200);
    expect((await guarded(no).request('/api/auth/sign-in/email-otp', { method: 'POST' }, e)).status).toBe(200);
  });

  it('lets the smoke tests past with the bypass token, and nobody without it', async () => {
    const token = 'b'.repeat(40);
    const e = { ...env, TURNSTILE_SECRET: 's', TURNSTILE_BYPASS_TOKEN: token };
    const post = (headers: Record<string, string>, en: Record<string, unknown> = e) => guarded(no).request(path, { method: 'POST', headers }, en);
    expect((await post({ 'x-turnstile-bypass': token })).status).toBe(200);
    expect((await post({ 'x-turnstile-bypass': `${token}x` })).status).toBe(403);
    expect((await post({ 'x-turnstile-bypass': '' })).status).toBe(403);
    // Unset, or too short to be a real secret: no bypass at all.
    expect((await post({ 'x-turnstile-bypass': token }, { ...e, TURNSTILE_BYPASS_TOKEN: undefined })).status).toBe(403);
    expect((await post({ 'x-turnstile-bypass': 'short' }, { ...e, TURNSTILE_BYPASS_TOKEN: 'short' })).status).toBe(403);
  });

  it('verifyTurnstile treats network failure as a failed check', async () => {
    expect(await verifyTurnstile('s', 't', undefined, async () => { throw new Error('down'); })).toBe(false);
  });
});

describe('requireSession', () => {
  function app(user: AppContext['Variables']['user']) {
    const a = new Hono<AppContext>();
    a.use('*', async (c, next) => {
      c.set('user', user);
      c.set('session', user ? ({ id: 's', userId: user.id } as AppContext['Variables']['session']) : null);
      await next();
    });
    a.get('*', requireSession, (c) => c.text('ok'));
    return a;
  }
  it('401 for API calls, sign-in redirect for navigations, 403 unless active', async () => {
    expect((await app(null).request('/api/me')).status).toBe(401);
    const nav = await app(null).request('/orgs/1?t=2', { headers: { 'sec-fetch-mode': 'navigate' } });
    expect(nav.status).toBe(302);
    expect(nav.headers.get('location')).toBe('/sign-in?next=%2Forgs%2F1%3Ft%3D2');
    const u = { id: 'u', email: 'a@b.c', name: '' };
    expect((await app({ ...u, status: 'pending' }).request('/x')).status).toBe(403);
    expect((await app({ ...u, status: 'disabled' }).request('/x')).status).toBe(403);
    expect((await app({ ...u, status: 'active' }).request('/x')).status).toBe(200);
  });
});

describe('email', () => {
  it('sends through Resend when configured', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ id: '1' });
    };
    await sendEmail({ ...env, RESEND_API_KEY: 're_x' } as Env, { to: 'a@b.c', subject: 's', text: 't', html: '<p>h</p>' }, fakeFetch);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ from: env.EMAIL_FROM, to: ['a@b.c'], subject: 's' });
    await expect(
      sendEmail({ ...env, RESEND_API_KEY: 're_x' } as Env, { to: 'a@b.c', subject: 's', text: 't', html: '' }, async () => new Response('no', { status: 500 })),
    ).rejects.toThrow();
  });

  it('refuses to capture mail outside local dev', async () => {
    await expect(sendEmail({ ...env, LOCAL_DEV: undefined, RESEND_API_KEY: undefined } as Env, { to: 'a@b.c', subject: 's', text: 't', html: '' })).rejects.toThrow();
  });

  it('escapes template input', () => {
    const inv = orgInvitationEmail({ orgName: '<b>Acme</b>', inviterName: 'Eve "x"', invitationId: 'i d', site: SITE });
    expect(inv.html).not.toContain('<b>Acme</b>');
    expect(inv.html).toContain('https://app.worca.dev/invite/i%20d');
    const act = actionEmail('Confirm', 'Body <script>', 'Go', 'https://app.worca.dev/confirm/x', SITE);
    expect(act.html).not.toContain('<script>');
  });

  it('puts every mail in the branded layout', () => {
    const html = signInCodeEmail('123456', SITE).html;
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('src="https://app.worca.dev/assets/mail/worca-logo-light.png"');
    expect(html).toMatch(/<img [^>]*alt="Worca"/);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('>123456</span>');
    for (const href of ['https://example.com/privacy/', 'https://example.com/terms/', 'https://example.com/legal/', 'mailto:hello@example.com']) expect(html).toContain(`href="${href}"`);
    expect(html).toContain('Example Hosting');
    // Text-only notices get the same chrome, with their URLs linked and text escaped.
    const notice = noticeEmailHtml({ subject: 'Ready <now>', text: 'Running at https://a.worca.run.\n\nBye', site: SITE });
    expect(notice).toContain('worca-logo-light.png');
    expect(notice).toContain('Ready &lt;now&gt;');
    expect(notice).toContain('href="https://a.worca.run"');
    // Names people choose can carry URLs: only worca's own hosts become links.
    const spoof = noticeEmailHtml({ subject: 'x', text: 'Org "Verify at https://evil.example/login" invited you; see https://app.worca.dev/x', site: SITE });
    expect(spoof).not.toContain('href="https://evil.example');
    expect(spoof).toContain('https://evil.example/login');
    expect(spoof).toContain('href="https://app.worca.dev/x"');
    expect(noticeEmailHtml({ subject: 'x', text: 'see https://worca.dev.evil.example/a', site: SITE })).not.toContain('href="https://worca.dev.evil');
    // The button is VML for Outlook and a link everywhere else.
    const inv = orgInvitationEmail({ orgName: 'Acme', inviterName: '', invitationId: 'i', site: SITE }).html;
    expect(inv).toContain('<v:roundrect');
    expect(inv.match(/href="https:\/\/app\.worca\.dev\/invite\/i"/g)).toHaveLength(2);
  });
});

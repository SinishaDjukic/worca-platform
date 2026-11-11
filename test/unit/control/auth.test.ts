// End-to-end through the Worker: email-code sign-in, registration modes, sessions, setup,
// pages and the dev mail capture (D22–D25, D50).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAuth } from '../../../packages/platform/src/control/auth/index';
import { claimCode, hashRegistrationCode } from '../../../packages/platform/src/control/auth/registration';

const ORIGIN = env.APP_ORIGIN;
let seq = 0;
const freshEmail = (tag: string) => `${tag}-${Date.now()}-${++seq}@example.com`;

async function setMode(mode: string) {
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', ?, 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(mode)
    .run();
}

async function addCode(code: string, uses = 1, tier = 'free') {
  await env.DB.prepare(`INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, ?, NULL, ?)`)
    .bind(await hashRegistrationCode(code), tier, uses, Date.now())
    .run();
}

const usesLeft = async (code: string) =>
  (await env.DB.prepare(`SELECT uses_left FROM registration_codes WHERE code_hash = ?`).bind(await hashRegistrationCode(code)).first<{ uses_left: number }>())
    ?.uses_left;

const userCount = async () => (await env.DB.prepare(`SELECT count(*) AS n FROM "user"`).first<{ n: number }>())!.n;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

async function latestCode(email: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`);
  expect(res.status).toBe(200);
  const mails = (await res.json()) as { subject: string; text: string }[];
  const match = /code: (\d{6})/.exec(mails.at(-1)!.subject);
  expect(match).not.toBeNull();
  return match![1]!;
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Requests a code, reads it from the captured mail, and submits it. */
async function signIn(email: string, headers: Record<string, string> = {}) {
  const sent = await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  expect(sent.status).toBe(200);
  const otp = await latestCode(email);
  const res = await post('/api/auth/sign-in/email-otp', { email, otp }, headers);
  return { res, cookie: cookiesOf(res) };
}

async function userRow(id: string) {
  return env.DB.prepare(`SELECT status, registeredVia, signupTier, emailVerified FROM "user" WHERE id = ?`)
    .bind(id)
    .first<{ status: string; registeredVia: string | null; signupTier: string | null; emailVerified: number }>();
}

beforeEach(async () => {
  await setMode('invite_code');
});

describe('registration modes (D25)', () => {
  it('invite_code: sign-up without a code is refused and creates no user', async () => {
    const before = await userCount();
    const { res } = await signIn(freshEmail('nocode'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toMatch(/signup_code_required/i);
    expect(await userCount()).toBe(before);
  });

  it('invite_code: an unknown code is refused', async () => {
    const { res } = await signIn(freshEmail('badcode'), { 'x-signup-code': 'nope-nope' });
    expect(res.status).toBe(403);
  });

  it('invite_code: a valid code creates an active user and is counted once', async () => {
    await addCode('CODE-ONE', 2, 'free');
    const email = freshEmail('withcode');
    const { res } = await signIn(email, { 'x-signup-code': 'CODE-ONE' });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    expect(await userRow(user.id)).toMatchObject({ status: 'active', registeredVia: 'code', signupTier: 'free' });
    expect(await usesLeft('CODE-ONE')).toBe(1);
    // Signing in again (existing user) never burns another use.
    const again = await signIn(email, { 'x-signup-code': 'CODE-ONE' });
    expect(again.res.status).toBe(200);
    expect(await usesLeft('CODE-ONE')).toBe(1);
  });

  it('invite_code: the code also works from the JSON body and the sign-in page cookie', async () => {
    await addCode('BODY-CODE', 1);
    await addCode('COOKIE-CODE', 1);
    const a = freshEmail('bodycode');
    await post('/api/auth/email-otp/send-verification-otp', { email: a, type: 'sign-in' });
    const viaBody = await post('/api/auth/sign-in/email-otp', { email: a, otp: await latestCode(a), signupCode: 'BODY-CODE' });
    expect(viaBody.status).toBe(200);
    const { res } = await signIn(freshEmail('cookiecode'), { cookie: 'worca_signup_code=COOKIE-CODE' });
    expect(res.status).toBe(200);
    expect(await usesLeft('BODY-CODE')).toBe(0);
    expect(await usesLeft('COOKIE-CODE')).toBe(0);
  });

  it('an exhausted code is refused', async () => {
    await addCode('ONE-SHOT', 1);
    expect((await signIn(freshEmail('first'), { 'x-signup-code': 'ONE-SHOT' })).res.status).toBe(200);
    expect((await signIn(freshEmail('second'), { 'x-signup-code': 'ONE-SHOT' })).res.status).toBe(403);
  });

  it('waitlist: new users are pending; a valid code skips the wait', async () => {
    await setMode('waitlist');
    const { res } = await signIn(freshEmail('wait'));
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    expect(await userRow(user.id)).toMatchObject({ status: 'pending', registeredVia: 'waitlist' });

    await addCode('SKIP', 1);
    const skip = await signIn(freshEmail('skip'), { 'x-signup-code': 'SKIP' });
    const skipped = (await skip.res.json()) as { user: { id: string } };
    expect((await userRow(skipped.user.id))?.status).toBe('active');
  });

  it('open: new users are active', async () => {
    await setMode('open');
    const { res } = await signIn(freshEmail('open'));
    const { user } = (await res.json()) as { user: { id: string } };
    expect(await userRow(user.id)).toMatchObject({ status: 'active', registeredVia: 'open' });
  });
});

describe('org invitations', () => {
  async function invite(email: string) {
    const ctx = await getAuth(env).$context;
    await setMode('open');
    const admin = await signIn(freshEmail('admin'));
    const adminUser = ((await admin.res.json()) as { user: { id: string } }).user;
    await setMode('invite_code');
    const now = new Date();
    const org = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'organization',
      data: { name: 'Acme', slug: `acme-${seq}-${Date.now()}`, createdAt: now },
    });
    await ctx.adapter.create({ model: 'member', data: { organizationId: org.id, userId: adminUser.id, role: 'tenant_admin', createdAt: now } });
    const inv = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
      model: 'invitation',
      data: {
        organizationId: org.id,
        email,
        role: 'tenant_user',
        status: 'pending',
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: now,
        inviterId: adminUser.id,
      },
    });
    return { orgId: org.id, invitationId: inv.id };
  }

  it('an invited address may register without a code in invite_code mode', async () => {
    const email = freshEmail('invited');
    await invite(email);
    const { res } = await signIn(email);
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    expect(await userRow(user.id)).toMatchObject({ status: 'active', registeredVia: 'invitation' });
  });

  it('accepting an invitation activates a waitlisted account as an invited member', async () => {
    await setMode('waitlist');
    const email = freshEmail('waitinvite');
    const { res, cookie } = await signIn(email);
    const { user } = (await res.json()) as { user: { id: string } };
    expect((await userRow(user.id))?.status).toBe('pending');
    const { invitationId } = await invite(email);

    const page = await SELF.fetch(`${ORIGIN}/invite/${invitationId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Acme');
    const accept = await SELF.fetch(`${ORIGIN}/invite/${invitationId}`, { method: 'POST', headers: { cookie, origin: ORIGIN }, redirect: 'manual' });
    expect(accept.status).toBe(303);
    expect(await userRow(user.id)).toMatchObject({ status: 'active', registeredVia: 'invitation' });
  });

  it('the invite page sends signed-out visitors to sign in', async () => {
    const res = await SELF.fetch(`${ORIGIN}/invite/abc`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Finvite%2Fabc');
  });
});

describe('sessions', () => {
  it('email-code sessions carry method email-otp and no MFA', async () => {
    await setMode('open');
    const { res, cookie } = await signIn(freshEmail('session'));
    expect(res.status).toBe(200);
    const s = await SELF.fetch(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } });
    const data = (await s.json()) as { session: { method: string; mfa: boolean }; user: { status: string } };
    expect(data.session.method).toBe('email-otp');
    expect(data.session.mfa).toBe(false);
    expect(data.user.status).toBe('active');
  });

  it('a disabled account cannot sign in', async () => {
    await setMode('open');
    const email = freshEmail('disabled');
    const { res } = await signIn(email);
    const { user } = (await res.json()) as { user: { id: string } };
    await env.DB.prepare(`UPDATE "user" SET status = 'disabled' WHERE id = ?`).bind(user.id).run();
    expect((await signIn(email)).res.status).toBe(403);
  });

  it('signed-in visitors to /sign-in go to next; sign-out clears the session', async () => {
    await setMode('open');
    const { cookie } = await signIn(freshEmail('signout'));
    const page = await SELF.fetch(`${ORIGIN}/sign-in?next=/orgs`, { headers: { cookie }, redirect: 'manual' });
    expect(page.headers.get('location')).toBe('/orgs');
    const out = await SELF.fetch(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie, origin: ORIGIN }, redirect: 'manual' });
    expect(out.status).toBe(303);
    const s = await SELF.fetch(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } });
    expect(await s.json()).toBeNull();
  });
});

describe('/api/setup', () => {
  it('creates the first superadmin once, then refuses', async () => {
    const email = freshEmail('root');
    expect((await post('/api/setup', { token: 'wrong', email })).status).toBe(403);
    const ok = await post('/api/setup', { token: env.SETUP_TOKEN, email, name: 'Root' });
    expect(ok.status).toBe(200);
    const { userId } = (await ok.json()) as { userId: string };
    expect(await userRow(userId)).toMatchObject({ status: 'active', registeredVia: 'setup', emailVerified: 1 });
    const role = await env.DB.prepare(`SELECT role FROM platform_roles WHERE user_id = ?`).bind(userId).first<{ role: string }>();
    expect(role?.role).toBe('superadmin');
    expect((await post('/api/setup', { token: env.SETUP_TOKEN, email: freshEmail('root2') })).status).toBe(409);
    // The superadmin signs in by email code even in invite_code mode (the user already exists).
    expect((await signIn(email)).res.status).toBe(200);
  });
});

describe('pages and plumbing', () => {
  it('serves /sign-in with security headers and a request id', async () => {
    const res = await SELF.fetch(`${ORIGIN}/sign-in`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(await res.text()).toContain('Sign-up code');
  });

  it('rejects an off-site next parameter', async () => {
    for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const html = await (await SELF.fetch(`${ORIGIN}/sign-in?next=${encodeURIComponent(next)}`)).text();
      expect(html).toContain('data-next="/"');
    }
    const html = await (await SELF.fetch(`${ORIGIN}/sign-in?next=${encodeURIComponent('/orgs/1?tab=a')}`)).text();
    expect(html).toContain('data-next="/orgs/1?tab=a"');
  });

  it('seals /api/auth/admin/*', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/auth/admin/list-users`)).status).toBe(403);
  });

  it('refuses the public SSO provider registration route', async () => {
    const body = { providerId: 'x', issuer: 'https://idp.example', domain: 'example.com', organizationId: 'o' };
    expect((await post('/api/auth/sso/register', body)).status).toBe(404);
    // Even past our route, Better Auth's before-hook refuses an HTTP call.
    const direct = await getAuth(env).handler(
      new Request(`${ORIGIN}/api/auth/sso/register`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) }),
    );
    expect(direct.status).toBe(403);
  });

  it('keeps Better Auth management endpoints off the HTTP surface', async () => {
    await setMode('open');
    const { cookie } = await signIn(freshEmail('mgmt'));
    for (const path of [
      '/organization/create',
      '/organization/delete',
      '/organization/remove-member',
      '/organization/update-member-role',
      '/organization/create-team',
      '/organization/invite-member',
      '/organization/update',
      '/delete-user',
      '/sso/register',
      '/sso/update-provider',
      '/sso/delete-provider',
      '/sso/request-domain-verification',
      '/sso/verify-domain',
      '/revoke-sessions',
      '/sign-out',
    ]) {
      const res = await post(`/api/auth${path}`, { organizationId: 'x' }, { cookie });
      expect(res.status, path).toBe(404);
    }
    // What the pages use stays reachable.
    expect((await SELF.fetch(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } })).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/api/auth/organization/list`, { headers: { cookie } })).status).toBe(200);
  });

  it('refuses cross-site state changes on our own routes', async () => {
    const res = await post('/api/setup', { token: 'x', email: 'a@b.c' }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_origin' });
  });

  it('captures mail under LOCAL_DEV', async () => {
    const res = await SELF.fetch(`${ORIGIN}/__dev/mail?to=nobody@example.com`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('security regressions', () => {
  it('lets only one of two concurrent sign-ups claim the last use of a code', async () => {
    const code = `race-${Date.now()}`;
    await addCode(code, 1);
    const [a, b] = await Promise.all([claimCode(env, code), claimCode(env, code)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await usesLeft(code)).toBe(0);
  });

  it('refuses adding a second passkey from an email-code session (D24)', async () => {
    await setMode('open');
    const email = freshEmail('pk');
    const { res, cookie } = await signIn(email);
    expect(res.status).toBe(200);
    const userId = ((await res.json()) as { user: { id: string } }).user.id;

    // First passkey: allowed from any session.
    const first = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-register-options`, { headers: { cookie, origin: ORIGIN } });
    expect(first.status).toBe(200);

    await env.DB.prepare(
      `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, transports, createdAt)
       VALUES (?, 'existing', 'pk', ?, ?, 0, 'singleDevice', 0, 'internal', ?)`,
    )
      .bind(crypto.randomUUID(), userId, `cred-${Date.now()}`, new Date().toISOString())
      .run();

    const second = await SELF.fetch(`${ORIGIN}/api/auth/passkey/generate-register-options`, { headers: { cookie, origin: ORIGIN } });
    expect(second.status).toBe(403);
    expect(((await second.json()) as { code?: string }).code).toBe('mfa_required');

    // Nor remove the existing one to get back to the first-passkey exception.
    const del = await post('/api/auth/passkey/delete-passkey', { id: 'any' }, { cookie });
    expect(del.status).toBe(403);
  });
});

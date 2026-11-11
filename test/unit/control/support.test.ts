// Platform support (P8): exact-email lookup, sign-out everywhere, disable/enable, and the
// two-person sign-in reset. Registration-code recording is checked through the real Worker.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideRegistration, hashRegistrationCode } from '../../../packages/platform/src/control/auth/registration';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import {
  addMember,
  ensureTables,
  type Fakes,
  gateCalls,
  grantPlatformRole,
  harness,
  insertRow,
  installFakes,
  resetGate,
  seedInstance,
  seedOrg,
  seedUser,
  testEnv,
  type TestUser,
} from './helpers/tenancy-fixtures';

let fakes: Fakes;
let root: TestUser;
let admin: TestUser;
let admin2: TestUser;
let support: TestUser;
const call = harness();

beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  await resetGate();
  root = await seedUser(fakes);
  await grantPlatformRole(root, 'superadmin');
  admin = await seedUser(fakes);
  await grantPlatformRole(admin, 'admin');
  admin2 = await seedUser(fakes);
  await grantPlatformRole(admin2, 'admin');
  support = await seedUser(fakes);
  await grantPlatformRole(support, 'support');
});

const as = (u: TestUser) => ({ as: u, mfa: true, method: 'passkey' as const });

async function seedSession(userId: string, opts: { method?: string; createdAt?: number; expiresAt?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow('session', {
    id,
    userId,
    token: await sha256Hex(id),
    method: opts.method ?? 'email-otp',
    mfa: opts.method === 'passkey' ? 1 : 0,
    expiresAt: new Date(opts.expiresAt ?? Date.now() + 3_600_000).toISOString(),
    createdAt: new Date(opts.createdAt ?? Date.now()).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

async function seedPasskey(userId: string): Promise<void> {
  const id = crypto.randomUUID();
  await insertRow('passkey', { id, name: 'key', publicKey: 'pk', userId, credentialID: id, counter: 0, deviceType: 'singleDevice', backedUp: 0, createdAt: new Date().toISOString() });
}

const json = async (res: Response) => res.json();
const count = async (sql: string, ...binds: unknown[]) => (await testEnv.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
const sessionsOf = (userId: string) => count('SELECT COUNT(*) AS n FROM session WHERE userId = ?', userId);
const statusOf = async (userId: string) => (await testEnv.DB.prepare('SELECT status FROM user WHERE id = ?').bind(userId).first<{ status: string }>())?.status;
const auditRows = (action: string) =>
  testEnv.DB.prepare('SELECT actor_id AS actorId, target_id AS targetId, details FROM audit_platform WHERE action = ? ORDER BY at').bind(action).all<{ actorId: string; targetId: string | null; details: string | null }>();

/** A tenant user with an org, an instance, two live sessions, a passkey and a Google account. */
async function seedCustomer(): Promise<{ user: TestUser; orgId: string; instanceId: string }> {
  const user = await seedUser(fakes, { name: 'Ana Customer' });
  const owner = await seedUser(fakes);
  const orgId = await seedOrg(fakes, owner, 'Customer Org');
  await addMember(orgId, user, 'tenant_user');
  const instanceId = await seedInstance(orgId);
  await seedSession(user.id, { method: 'email-otp', createdAt: Date.now() - 60_000 });
  await seedSession(user.id, { method: 'passkey', createdAt: Date.now() - 1_000 });
  await seedSession(user.id, { method: 'google', createdAt: Date.now() - 120_000, expiresAt: Date.now() - 1 }); // expired
  await seedPasskey(user.id);
  await insertRow('account', { id: crypto.randomUUID(), userId: user.id, accountId: 'g-1', providerId: 'google', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return { user, orgId, instanceId };
}

describe('find a user (exact email only)', () => {
  it('returns the account, orgs, sign-in methods, roles, last sign-in and session count', async () => {
    const { user, orgId } = await seedCustomer();
    const res = await call('GET', `/api/platform/users?email=${encodeURIComponent(`  ${user.email.toUpperCase()} `.trim())}`, as(admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: user.id,
      email: user.email,
      name: 'Ana Customer',
      status: 'active',
      orgs: [{ id: orgId, name: 'Customer Org', role: 'tenant_user' }],
      signInMethods: { passkeys: 1, providers: ['google'] },
      platformRoles: [],
      lastSignIn: { method: 'passkey' },
      activeSessions: 2,
    });
    expect(body).toHaveProperty('registrationCodeId', null);
    const audit = (await auditRows('support.user_looked_up')).results;
    expect(audit.at(-1)).toMatchObject({ actorId: admin.id, targetId: user.id });
    expect(audit.at(-1)?.details).not.toContain(user.email);
  });

  it('has no browsing and no partial match; misses are audited too', async () => {
    const { user } = await seedCustomer();
    expect((await call('GET', '/api/platform/users', as(admin))).status).toBe(400);
    expect((await call('GET', '/api/platform/users?email=%25', as(admin))).status).toBe(400);
    expect((await call('GET', `/api/platform/users?email=${encodeURIComponent(user.email.split('@')[0] as string)}`, as(admin))).status).toBe(400);
    const partial = user.email.replace('@example.com', '@example.co');
    expect((await call('GET', `/api/platform/users?email=${encodeURIComponent(partial)}`, as(admin))).status).toBe(404);
    expect((await call('GET', `/api/platform/users?email=${encodeURIComponent(`x${user.email}`)}`, as(admin))).status).toBe(404);
    const misses = (await auditRows('support.user_looked_up')).results.filter((r) => r.targetId === null);
    expect(misses.length).toBe(2);
    expect(misses[0]?.details).toBe('{"found":false}');
  });

  it('is admin work with a passkey session; support and email-code sessions are refused', async () => {
    const { user } = await seedCustomer();
    const q = `/api/platform/users?email=${encodeURIComponent(user.email)}`;
    expect((await call('GET', q, as(support))).status).toBe(403);
    expect((await call('GET', q, { as: admin, mfa: false })).status).toBe(403);
    expect((await call('GET', q)).status).toBe(401);
    expect((await call('GET', q, as(root))).status).toBe(200);
  });
});

describe('sign out everywhere, disable, enable', () => {
  it('sign-out ends every session and drops gate sessions', async () => {
    const { user, instanceId } = await seedCustomer();
    const res = await call('POST', `/api/platform/users/${user.id}/sign-out`, as(admin));
    expect(res.status).toBe(200);
    expect(await sessionsOf(user.id)).toBe(0);
    expect(await statusOf(user.id)).toBe('active');
    expect(await gateCalls()).toContainEqual(['dropSessions', instanceId, { userId: user.id }]);
    expect((await auditRows('support.user_signed_out')).results.at(-1)).toMatchObject({ actorId: admin.id, targetId: user.id });
  });

  it('disabling revokes live sessions and gate sessions immediately; enabling restores', async () => {
    const { user, instanceId } = await seedCustomer();
    expect(await count('SELECT COUNT(*) AS n FROM session WHERE userId = ? AND expiresAt > ?', user.id, new Date().toISOString())).toBe(2);
    const res = await call('POST', `/api/platform/users/${user.id}/disable`, as(admin));
    expect(res.status).toBe(200);
    expect(await statusOf(user.id)).toBe('disabled');
    expect(await sessionsOf(user.id)).toBe(0);
    expect(await gateCalls()).toContainEqual(['dropSessions', instanceId, { userId: user.id }]);
    expect((await auditRows('support.user_disabled')).results.at(-1)).toMatchObject({ actorId: admin.id, targetId: user.id });

    // A session that slipped in is closed by disabling again.
    await seedSession(user.id);
    expect((await call('POST', `/api/platform/users/${user.id}/disable`, as(admin))).status).toBe(200);
    expect(await sessionsOf(user.id)).toBe(0);

    expect((await call('POST', `/api/platform/users/${user.id}/enable`, as(admin))).status).toBe(200);
    expect(await statusOf(user.id)).toBe('active');
    expect((await call('POST', `/api/platform/users/${user.id}/enable`, as(admin))).status).toBe(409);
  });

  it('refuses disabling yourself, pending accounts, unknown users and stronger roles', async () => {
    expect((await call('POST', `/api/platform/users/${admin.id}/disable`, as(admin))).status).toBe(403);
    expect((await call('POST', `/api/platform/users/${root.id}/disable`, as(root))).status).toBe(403);
    const pending = await seedUser(fakes, { status: 'pending' });
    expect((await call('POST', `/api/platform/users/${pending.id}/disable`, as(admin))).status).toBe(409);
    expect((await call('POST', `/api/platform/users/${crypto.randomUUID()}/disable`, as(admin))).status).toBe(404);
    // An admin can't disable or sign out a superadmin.
    expect((await call('POST', `/api/platform/users/${root.id}/disable`, as(admin))).status).toBe(403);
    expect((await call('POST', `/api/platform/users/${root.id}/sign-out`, as(admin))).status).toBe(403);
    expect(await statusOf(root.id)).toBe('active');
    // Support may do none of it.
    const { user } = await seedCustomer();
    expect((await call('POST', `/api/platform/users/${user.id}/disable`, as(support))).status).toBe(403);
    expect((await call('POST', `/api/platform/users/${user.id}/sign-out`, as(support))).status).toBe(403);
  });

  it('nobody acts on an equal or stronger platform role; superadmins act on admins', async () => {
    const root2 = await seedUser(fakes);
    await grantPlatformRole(root2, 'superadmin');
    // Superadmin on superadmin: refused (the last-superadmin guard stays in the UPDATE as well).
    expect(await json(await call('POST', `/api/platform/users/${root2.id}/disable`, as(root)))).toEqual({ error: 'target_outranks_you' });
    expect((await call('POST', `/api/platform/users/${root2.id}/sign-out`, as(root))).status).toBe(403);
    expect(await statusOf(root2.id)).toBe('active');
    // Admin on admin: refused for every action.
    await seedSession(admin2.id);
    for (const action of ['sign-out', 'disable', 'enable']) {
      expect(await json(await call('POST', `/api/platform/users/${admin2.id}/${action}`, as(admin)))).toEqual({ error: 'target_outranks_you' });
    }
    expect((await call('POST', `/api/platform/users/${admin2.id}/reset-signin`, { ...as(admin), body: { reason: 'r' } })).status).toBe(403);
    expect(await statusOf(admin2.id)).toBe('active');
    expect(await sessionsOf(admin2.id)).toBe(1);
    // Superadmin on admin: allowed, and recorded as the disabler.
    expect((await call('POST', `/api/platform/users/${admin2.id}/disable`, as(root))).status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT status, disabledBy, disabledByRole FROM user WHERE id = ?').bind(admin2.id).first();
    expect(row).toEqual({ status: 'disabled', disabledBy: root.id, disabledByRole: 'superadmin' });
    expect((await call('POST', `/api/platform/users/${admin2.id}/enable`, as(root))).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT status, disabledBy, disabledByRole FROM user WHERE id = ?').bind(admin2.id).first()).toEqual({
      status: 'active',
      disabledBy: null,
      disabledByRole: null,
    });
  });

  it('re-enabling needs at least the rank of whoever disabled the account', async () => {
    const { user } = await seedCustomer();
    expect((await call('POST', `/api/platform/users/${user.id}/disable`, as(root))).status).toBe(200);
    expect(await json(await call('POST', `/api/platform/users/${user.id}/enable`, as(admin)))).toEqual({ error: 'disabler_outranks_you' });
    expect(await statusOf(user.id)).toBe('disabled');
    // A later demotion of the disabler doesn't lower the bar: the role at disable time counts.
    await testEnv.DB.prepare("UPDATE platform_roles SET role = 'admin' WHERE user_id = ?").bind(root.id).run();
    expect((await call('POST', `/api/platform/users/${user.id}/enable`, as(admin))).status).toBe(403);
    await testEnv.DB.prepare("UPDATE platform_roles SET role = 'superadmin' WHERE user_id = ?").bind(root.id).run();
    expect((await call('POST', `/api/platform/users/${user.id}/enable`, as(root))).status).toBe(200);

    // Disabled by an admin: another admin may re-enable.
    expect((await call('POST', `/api/platform/users/${user.id}/disable`, as(admin))).status).toBe(200);
    expect((await call('POST', `/api/platform/users/${user.id}/enable`, as(admin2))).status).toBe(200);
    expect(await statusOf(user.id)).toBe('active');
    const enabled = (await auditRows('support.user_enabled')).results.at(-1);
    expect(JSON.parse(enabled?.details ?? '{}')).toEqual({ disabledBy: admin.id });
  });
});

describe('two-person sign-in reset', () => {
  async function request(by: TestUser, userId: string, reason = 'Lost both keys; verified by video call') {
    return call('POST', `/api/platform/users/${userId}/reset-signin`, { ...as(by), body: { reason } });
  }

  it('one admin requests, a different one approves with a passkey: passkeys and sessions go, mail sent', async () => {
    const { user, instanceId } = await seedCustomer();
    await seedPasskey(user.id);
    const created = await request(admin, user.id);
    expect(created.status).toBe(201);
    const { id, expiresAt } = (await created.json()) as { id: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);

    // The reason is stored encrypted with the user's key.
    const stored = await testEnv.DB.prepare('SELECT reason, status FROM support_requests WHERE id = ?').bind(id).first<{ reason: string; status: string }>();
    expect(stored?.reason).not.toContain('Lost both keys');
    expect(stored?.status).toBe('open');

    // A second open request for the same user is refused.
    expect((await request(admin2, user.id)).status).toBe(409);

    const list = (await (await call('GET', '/api/platform/support-requests', as(admin2))).json()) as { requests: Record<string, unknown>[] };
    expect(list.requests.find((r) => r.id === id)).toMatchObject({ userId: user.id, requestedBy: admin.id, email: user.email, reason: 'Lost both keys; verified by video call', canApprove: true });
    const own = (await (await call('GET', '/api/platform/support-requests', as(admin))).json()) as { requests: Record<string, unknown>[] };
    expect(own.requests.find((r) => r.id === id)).toMatchObject({ canApprove: false });

    // Self-approval is refused; so is an email-code session of another admin.
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin))).status).toBe(403);
    const emailSession = await call('POST', `/api/platform/support-requests/${id}/approve`, { as: admin2, mfa: true, method: 'email-otp' });
    expect(emailSession.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?', user.id)).toBe(2);

    const ok = await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin2));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, passkeys: 2, sessions: 3 });
    expect(await count('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?', user.id)).toBe(0);
    expect(await sessionsOf(user.id)).toBe(0);
    expect(await gateCalls()).toContainEqual(['dropSessions', instanceId, { userId: user.id }]);
    const done = await testEnv.DB.prepare('SELECT status, approved_by, executed_at FROM support_requests WHERE id = ?').bind(id).first<{ status: string; approved_by: string; executed_at: number | null }>();
    expect(done).toMatchObject({ status: 'executed', approved_by: admin2.id });
    expect(done?.executed_at).toBeTypeOf('number');
    expect(fakes.mail.at(-1)).toMatchObject({ to: user.email, subject: 'Your Worca sign-in was reset' });
    const audit = (await auditRows('support.reset_executed')).results.at(-1);
    expect(audit).toMatchObject({ actorId: admin2.id, targetId: user.id });
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ requestId: id, requestedBy: admin.id });
    expect((await auditRows('support.reset_requested')).results.at(-1)).toMatchObject({ actorId: admin.id, targetId: user.id });

    // Executed once only; no longer listed.
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(root))).status).toBe(409);
    const after = (await (await call('GET', '/api/platform/support-requests', as(root))).json()) as { requests: { id: string }[] };
    expect(after.requests.map((r) => r.id)).not.toContain(id);
  });

  it('expired requests cannot be approved and are not listed', async () => {
    const { user } = await seedCustomer();
    const { id } = (await (await request(admin, user.id)).json()) as { id: string };
    await testEnv.DB.prepare('UPDATE support_requests SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, id).run();
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin2))).status).toBe(410);
    expect(await count('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?', user.id)).toBe(1);
    const list = (await (await call('GET', '/api/platform/support-requests', as(admin2))).json()) as { requests: { id: string }[] };
    expect(list.requests.map((r) => r.id)).not.toContain(id);
    // An expired request doesn't block a new one.
    expect((await request(admin, user.id)).status).toBe(201);
  });

  it('the staff member being reset can neither request nor approve it', async () => {
    const root2 = await seedUser(fakes);
    await grantPlatformRole(root2, 'superadmin');
    expect((await request(admin2, admin2.id)).status).toBe(403);
    // An admin can't request a reset of another admin; a superadmin can.
    expect((await request(admin, admin2.id)).status).toBe(403);
    const { id } = (await (await request(root, admin2.id)).json()) as { id: string };
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin2))).status).toBe(403);
    // Another admin can't approve it either: the target is an admin too.
    expect(await json(await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin)))).toEqual({ error: 'target_outranks_you' });
    expect((await testEnv.DB.prepare('SELECT status FROM support_requests WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('open');
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(root2))).status).toBe(200);
  });

  it('approval re-checks the requester against the target: a promoted target voids the request', async () => {
    const { user } = await seedCustomer();
    const { id } = (await (await request(admin, user.id)).json()) as { id: string };
    // The target becomes an admin after the request: admin2 may no longer act on them, and the
    // superadmin approver passes but the admin requester no longer outranks the target.
    await grantPlatformRole({ ...user }, 'admin');
    expect(await json(await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin2)))).toEqual({ error: 'target_outranks_you' });
    expect(await json(await call('POST', `/api/platform/support-requests/${id}/approve`, as(root)))).toEqual({ error: 'requester_outranked' });
    expect(await count('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?', user.id)).toBe(1);
    expect((await testEnv.DB.prepare('SELECT status FROM support_requests WHERE id = ?').bind(id).first<{ status: string }>())?.status).toBe('open');
  });

  it('admins cannot reset a superadmin; support cannot request; a demoted requester voids the request', async () => {
    expect((await request(admin, root.id)).status).toBe(403);
    const { user } = await seedCustomer();
    expect((await request(support, user.id)).status).toBe(403);
    expect((await call('POST', `/api/platform/users/${user.id}/reset-signin`, { ...as(admin), body: { reason: ' ' } })).status).toBe(400);
    const { id } = (await (await request(admin, user.id)).json()) as { id: string };
    await testEnv.DB.prepare('DELETE FROM platform_roles WHERE user_id = ?').bind(admin.id).run();
    expect((await call('POST', `/api/platform/support-requests/${id}/approve`, as(admin2))).status).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?', user.id)).toBe(1);
    expect((await call('POST', `/api/platform/support-requests/${crypto.randomUUID()}/approve`, as(admin2))).status).toBe(404);
  });
});

describe('registration code is recorded on the user', () => {
  it('decideRegistration returns the claimed code id, and null otherwise', async () => {
    const code = `REC-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, 1, NULL, ?)')
      .bind(await hashRegistrationCode(code), 'free', Date.now())
      .run();
    const base = { email: 'x@example.com', emailVerified: true, hasPendingInvitation: async () => false };
    expect(await decideRegistration(testEnv, { ...base, code })).toMatchObject({ registeredVia: 'code', registrationCodeId: await hashRegistrationCode(code) });
    expect(await decideRegistration(testEnv, { ...base, code: null, hasPendingInvitation: async () => true })).toMatchObject({ registrationCodeId: null });
  });

  it('a sign-up with a code stores which code it was', async () => {
    const ORIGIN = env.APP_ORIGIN;
    const code = `SUP-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'invite_code', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    await env.DB.prepare('INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, 1, NULL, ?)')
      .bind(await hashRegistrationCode(code), 'free', Date.now())
      .run();
    const email = `support-code-${Date.now()}@example.com`;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body), redirect: 'manual' });
    expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
    const otp = /code: (\d{6})/.exec(mails.at(-1)?.subject ?? '')?.[1];
    expect(otp).toBeTruthy();
    const res = await post('/api/auth/sign-in/email-otp', { email, otp }, { 'x-signup-code': code });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: Record<string, unknown> & { id: string } };
    expect(user).not.toHaveProperty('registrationCodeId'); // returned: false
    const row = await env.DB.prepare('SELECT registeredVia, registrationCodeId FROM "user" WHERE id = ?').bind(user.id).first();
    expect(row).toEqual({ registeredVia: 'code', registrationCodeId: await hashRegistrationCode(code) });
  });
});

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ensureTables,
  type Fakes,
  grantPlatformRole,
  harness,
  installFakes,
  lastConfirmLink,
  resetGate,
  seedInstance,
  seedOrg,
  seedTeam,
  seedUser,
  testEnv,
} from './helpers/tenancy-fixtures';

let fakes: Fakes;
const call = harness();
beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  await resetGate();
});

describe('org deletion (D29, D30, D31)', () => {
  it('typed name + MFA, then an emailed link that only acts on POST by the same signed-in user', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin, 'Acme');
    const other = await seedUser(fakes);
    await addMember(orgId, other, 'tenant_admin');
    await seedTeam(fakes, orgId, 'Eng', [other]);
    const inst = await seedInstance(orgId);

    expect((await call('DELETE', `/api/orgs/${orgId}`, { as: admin, mfa: true, body: { confirmName: 'acme' } })).status).toBe(422);
    expect((await call('DELETE', `/api/orgs/${orgId}`, { as: admin, body: { confirmName: 'Acme' } })).status).toBe(403);
    const started = await call('DELETE', `/api/orgs/${orgId}`, { as: admin, mfa: true, body: { confirmName: 'Acme' } });
    expect(started.status).toBe(202);
    const { id, token } = lastConfirmLink(fakes);
    expect(fakes.mail.at(-1)?.to).toBe(admin.email);
    const stored = await testEnv.DB.prepare('SELECT token_hash, payload FROM confirmations WHERE id = ?').bind(id).first<{ token_hash: string; payload: string }>();
    expect(stored?.token_hash).not.toContain(token);
    expect(stored?.payload.startsWith('enc:v1:')).toBe(true);

    // GET never acts; it shows a form.
    expect((await call('GET', `/confirm/${id}?t=${token}`)).status).toBe(401);
    const page = await call('GET', `/confirm/${id}?t=${token}`, { as: admin, mfa: true });
    expect(page.status).toBe(200);
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(await page.text()).toContain('method="post"');
    expect(await testEnv.DB.prepare('SELECT 1 FROM organization WHERE id = ?').bind(orgId).first()).not.toBeNull();

    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: 'wrong' } })).status).toBe(410);
    expect((await call('POST', `/confirm/${id}`, { as: other, mfa: true, form: { t: token } })).status).toBe(403);
    expect((await call('POST', `/confirm/${id}`, { as: admin, form: { t: token } })).status).toBe(403); // D24
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token }, headers: { origin: 'https://evil.example' } })).status).toBe(403);

    const done = await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } });
    expect(done.status).toBe(200);
    expect(fakes.instanceCalls).toContainEqual(['deleteInstanceNow', inst, { actorId: admin.id }]);
    expect(fakes.ring.destroyed.has(`org:${orgId}`)).toBe(true);
    for (const sql of ['SELECT 1 FROM organization WHERE id = ?', 'SELECT 1 FROM member WHERE organizationId = ?', 'SELECT 1 FROM team WHERE organizationId = ?', 'SELECT 1 FROM org_settings WHERE org_id = ?', 'SELECT 1 FROM audit_org WHERE org_id = ?']) {
      expect(await testEnv.DB.prepare(sql).bind(orgId).first()).toBeNull();
    }
    const record = await testEnv.DB.prepare("SELECT actor_id, details FROM audit_platform WHERE action = 'org.deleted' AND target_id = ?").bind(orgId).first<{ actor_id: string; details: string }>();
    expect(record?.actor_id).toBe(admin.id);
    expect(JSON.parse(record?.details ?? '{}')).toEqual({ instances: 1, members: 2 });
    expect(fakes.mail.some((m) => m.to === other.email && m.subject.includes('confirmed'))).toBe(true);

    // Single use.
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } })).status).toBe(410);
  });

  it('expires after 30 minutes and requires the starter to still be a tenant admin', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin, 'Acme');
    const second = await seedUser(fakes);
    await addMember(orgId, second, 'tenant_admin');
    await call('DELETE', `/api/orgs/${orgId}`, { as: admin, mfa: true, body: { confirmName: 'Acme' } });
    const first = lastConfirmLink(fakes);
    await testEnv.DB.prepare('UPDATE confirmations SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, first.id).run();
    expect((await call('POST', `/confirm/${first.id}`, { as: admin, mfa: true, form: { t: first.token } })).status).toBe(410);

    await call('DELETE', `/api/orgs/${orgId}`, { as: admin, mfa: true, body: { confirmName: 'Acme' } });
    const again = lastConfirmLink(fakes);
    await testEnv.DB.prepare("UPDATE member SET role = 'tenant_user' WHERE organizationId = ? AND userId = ?").bind(orgId, admin.id).run();
    expect((await call('POST', `/confirm/${again.id}`, { as: admin, mfa: true, form: { t: again.token } })).status).toBe(403);
    expect(await testEnv.DB.prepare('SELECT 1 FROM organization WHERE id = ?').bind(orgId).first()).not.toBeNull();
  });

  it('a confirmed lock-out policy change is applied by the POST', async () => {
    const admin = await seedUser(fakes, { email: 'a@acme.com' });
    const orgId = await seedOrg(fakes, admin, 'Acme');
    await addMember(orgId, await seedUser(fakes, { email: 'x@else.com' }));
    const body = { allowedMethods: ['sso'], requiredDomain: 'acme.com', confirmName: 'Acme' };
    expect((await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body })).status).toBe(202);
    const { id, token } = lastConfirmLink(fakes);
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } })).status).toBe(200);
    const policy = await (await call('GET', `/api/orgs/${orgId}/policy`, { as: admin })).json();
    expect(policy).toEqual({ allowedMethods: ['sso'], requiredDomain: 'acme.com', instanceOverrides: [] });
  });
});

describe('account (D59)', () => {
  it('profile, rename and export', async () => {
    const me = await seedUser(fakes, { name: 'Ann' });
    const orgId = await seedOrg(fakes, me, 'Acme');
    await grantPlatformRole(me, 'support');
    const profile = await (await call('GET', '/api/me', { as: me })).json();
    expect(profile).toMatchObject({ user: { id: me.id }, orgs: [{ id: orgId, name: 'Acme', role: 'tenant_admin' }], platformRoles: ['support'] });
    expect((await call('PATCH', '/api/me', { as: me, body: { name: 'Anna' } })).status).toBe(200);
    await call('PATCH', `/api/orgs/${orgId}`, { as: me, body: { name: 'Acme 2' } });
    const exp = (await (await call('GET', '/api/me/export', { as: me })).json()) as {
      profile: { name: string };
      audit: { platform: { action: string }[]; orgs: { entries: { action: string }[] }[] };
    };
    expect(exp.profile.name).toBe('Anna');
    expect(exp.audit.platform.map((e) => e.action)).toContain('user.renamed');
    expect(exp.audit.orgs[0]?.entries.map((e) => e.action)).toContain('org.renamed');
  });

  it('refused while the last tenant admin; otherwise deleted after the emailed confirmation', async () => {
    const me = await seedUser(fakes);
    const orgId = await seedOrg(fakes, me, 'Acme');
    const team = await seedTeam(fakes, orgId, 'Eng', [me]);
    const inst = await seedInstance(orgId, { teams: [team] });
    expect((await call('DELETE', '/api/me', { as: me, body: { confirmName: me.email } })).status).toBe(409);

    const heir = await seedUser(fakes);
    await addMember(orgId, heir, 'tenant_admin');
    expect((await call('DELETE', '/api/me', { as: me, body: { confirmName: 'nope' } })).status).toBe(422);
    expect((await call('DELETE', '/api/me', { as: me, body: { confirmName: me.email.toUpperCase() } })).status).toBe(202);
    const { id, token } = lastConfirmLink(fakes);
    expect((await call('POST', `/confirm/${id}`, { as: me, form: { t: token } })).status).toBe(200);

    expect(await testEnv.DB.prepare('SELECT 1 FROM user WHERE id = ?').bind(me.id).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT 1 FROM member WHERE userId = ?').bind(me.id).first()).toBeNull();
    expect(fakes.ring.destroyed.has(`user:${me.id}`)).toBe(true);
    const calls = (await (testEnv.GATE as unknown as { calls(): Promise<unknown[]> }).calls()) as unknown[];
    expect(calls).toContainEqual(['dropSessions', inst, { userId: me.id }]);
  });
});

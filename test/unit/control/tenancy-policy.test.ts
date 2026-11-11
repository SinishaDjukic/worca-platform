import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditOrg, auditPlatform, pruneAudit, readOrgAudit, sanitizePlatformDetails } from '../../../packages/platform/src/control/tenancy/audit';
import { checkInstanceAccess, effectiveMethods } from '../../../packages/platform/src/control/tenancy/policy';
import { addMember, ensureTables, type Fakes, installFakes, seedInstance, seedOrg, seedTeam, seedUser, testEnv } from './helpers/tenancy-fixtures';

let fakes: Fakes;
beforeAll(ensureTables);
beforeEach(() => {
  fakes = installFakes();
});

async function setOrgPolicy(orgId: string, methods: string[], domain: string | null) {
  const idx = domain ? await fakes.ring.blindIndex(`domain:${domain}`) : null;
  await testEnv.DB.prepare(
    'INSERT OR REPLACE INTO org_login_policies (org_id, allowed_methods, required_domain, required_domain_index, updated_at) VALUES (?, ?, NULL, ?, ?)',
  )
    .bind(orgId, JSON.stringify(methods), idx, Date.now())
    .run();
}

describe('checkInstanceAccess (D19, D23)', () => {
  it('walks instance → member → team → policy', async () => {
    const admin = await seedUser(fakes, { email: 'boss@acme.com' });
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes, { email: 'bob@acme.com' });
    const team = await seedTeam(fakes, orgId, 'Eng', [bob]);
    const otherTeam = await seedTeam(fakes, orgId, 'Ops');
    const inst = await seedInstance(orgId, { teams: [team, otherTeam] });
    const check = (userId: string, method = 'email-otp', instanceId = inst) => checkInstanceAccess(testEnv, { userId, sessionMethod: method, ssoOrgId: orgId, instanceId });

    expect(await check(bob.id, 'email-otp', crypto.randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(await check(bob.id)).toEqual({ ok: false, reason: 'not_member' });
    await addMember(orgId, bob);
    expect(await check(bob.id)).toEqual({ ok: true, orgId, teamIds: [team] });
    expect(await check(admin.id)).toEqual({ ok: false, reason: 'no_team' }); // admins too: no direct grants

    await setOrgPolicy(orgId, ['passkey', 'sso'], null);
    expect(await check(bob.id)).toEqual({ ok: false, reason: 'policy_method', requiredMethods: ['passkey', 'sso'] });
    expect((await check(bob.id, 'passkey')).ok).toBe(true);

    await testEnv.DB.prepare('INSERT INTO instance_login_policies (instance_id, required_methods, updated_at) VALUES (?, ?, ?)').bind(inst, '["sso"]', Date.now()).run();
    expect(await check(bob.id, 'passkey')).toEqual({ ok: false, reason: 'policy_method', requiredMethods: ['sso'] });
    expect((await check(bob.id, 'sso')).ok).toBe(true);
    // SSO through another org's provider doesn't count as this org's SSO.
    const viaOtherOrg = await checkInstanceAccess(testEnv, { userId: bob.id, sessionMethod: 'sso', ssoOrgId: 'some-other-org', instanceId: inst });
    expect(viaOtherOrg).toEqual({ ok: false, reason: 'policy_method', requiredMethods: ['sso'] });
    expect((await checkInstanceAccess(testEnv, { userId: bob.id, sessionMethod: 'sso', ssoOrgId: orgId, instanceId: inst })).ok).toBe(true);

    await setOrgPolicy(orgId, [], 'other.com');
    expect(await check(bob.id, 'sso')).toEqual({ ok: false, reason: 'policy_domain' });
    await setOrgPolicy(orgId, [], 'acme.com');
    expect((await check(bob.id, 'sso')).ok).toBe(true);

    await testEnv.DB.prepare("UPDATE user SET status = 'disabled' WHERE id = ?").bind(bob.id).run();
    expect(await check(bob.id, 'sso')).toEqual({ ok: false, reason: 'disabled' });

    await testEnv.DB.prepare("UPDATE instances SET status = 'deleting' WHERE id = ?").bind(inst).run();
    expect(await check(bob.id, 'sso')).toEqual({ ok: false, reason: 'not_found' });
  });

  it("a team of another org assigned to the instance grants nothing", async () => {
    const a = await seedUser(fakes);
    const orgA = await seedOrg(fakes, a);
    const b = await seedUser(fakes);
    const orgB = await seedOrg(fakes, b);
    await addMember(orgA, b);
    const foreignTeam = await seedTeam(fakes, orgB, 'B', [b]);
    const inst = await seedInstance(orgA, { teams: [foreignTeam] });
    expect(await checkInstanceAccess(testEnv, { userId: b.id, sessionMethod: 'email-otp', instanceId: inst })).toEqual({ ok: false, reason: 'no_team' });
  });

  it('effective methods fail closed when org and instance no longer overlap', () => {
    expect(effectiveMethods([], [])).toBeNull();
    expect(effectiveMethods(['passkey'], [])).toEqual(['passkey']);
    expect(effectiveMethods([], ['sso'])).toEqual(['sso']);
    expect(effectiveMethods(['passkey'], ['sso'])).toEqual([]);
  });
});

describe('audit (D40, D41, D57)', () => {
  it('platform details keep ids and numbers, never free text', () => {
    expect(sanitizePlatformDetails({ orgId: 'abc-123', n: 3, name: 'Acme Corp', email: 'a@b.c' })).toEqual({ orgId: 'abc-123', n: 3, name: '[redacted]', email: '[redacted]' });
  });

  it('org details are encrypted and read back; a destroyed key leaves null details', async () => {
    const orgId = crypto.randomUUID();
    await testEnv.DB.prepare('INSERT INTO org_settings (org_id, created_at) VALUES (?, ?)').bind(orgId, Date.now()).run();
    await auditOrg(testEnv, orgId, { actorId: 'u1', actorScope: 'tenant', action: 'team.created', targetType: 'team', targetId: 't1', details: { name: 'Secret' } });
    expect((await readOrgAudit(testEnv, orgId))[0]).toMatchObject({ action: 'team.created', details: { name: 'Secret' } });
    await fakes.ring.destroyKey({ type: 'org', id: orgId });
    expect((await readOrgAudit(testEnv, orgId))[0]?.details).toBeNull();
  });

  it('retries once, then counts the lost write in KV', async () => {
    let attempts = 0;
    const brokenDb = { prepare: () => ({ bind: () => ({ run: async () => { attempts++; throw new Error('db down'); } }) }) };
    const env = { ...testEnv, DB: brokenDb as unknown as D1Database };
    const key = `audit:failures:${new Date().toISOString().slice(0, 10)}`;
    const before = Number((await testEnv.KV.get(key)) ?? 0);
    await auditPlatform(env, { actorId: null, actorRole: 'system', action: 'audit.pruned', targetType: 'system', targetId: null });
    expect(attempts).toBe(2);
    expect(Number(await testEnv.KV.get(key))).toBe(before + 1);
  });

  it('prunes after 30 days; triggers keep recent rows and forbid updates', async () => {
    const old = Date.now() - 31 * 86_400_000;
    const orgId = crypto.randomUUID();
    await testEnv.DB.prepare('INSERT INTO org_settings (org_id, created_at) VALUES (?, ?)').bind(orgId, Date.now()).run();
    await testEnv.DB.batch([
      testEnv.DB.prepare("INSERT INTO audit_platform (id, at, action) VALUES ('old-p', ?, 'x')").bind(old),
      testEnv.DB.prepare("INSERT INTO audit_org (id, org_id, at, actor_scope, action) VALUES ('old-o', ?, ?, 'tenant', 'x')").bind(orgId, old),
      testEnv.DB.prepare("INSERT INTO audit_org (id, org_id, at, actor_scope, action) VALUES ('new-o', ?, ?, 'tenant', 'x')").bind(orgId, Date.now()),
    ]);
    await expect(testEnv.DB.prepare("DELETE FROM audit_org WHERE id = 'new-o'").run()).rejects.toThrow(/30 days/);
    await expect(testEnv.DB.prepare("UPDATE audit_org SET action = 'y' WHERE id = 'new-o'").run()).rejects.toThrow(/append-only/);
    const counts = await pruneAudit(testEnv);
    expect(counts.platform).toBeGreaterThanOrEqual(1);
    expect(counts.org).toBeGreaterThanOrEqual(1);
    const left = await testEnv.DB.prepare("SELECT id FROM audit_org WHERE id IN ('old-o', 'new-o')").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(['new-o']);
    // Once the org is gone its log may go too (security.md "Audit trail").
    await testEnv.DB.prepare('DELETE FROM org_settings WHERE org_id = ?').bind(orgId).run();
    await testEnv.DB.prepare("DELETE FROM audit_org WHERE id = 'new-o'").run();
  });
});

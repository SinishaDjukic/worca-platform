// Member directory role-shaping, member-visible teams, per-team instance grants, invitation
// resend and audit filters (T1, T9, T10, T12, T15, P9).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditCategoryOf, auditOrg, auditPlatform, readOrgAudit, readPlatformAudit } from '../../../packages/platform/src/control/tenancy/audit';
import { deps, setTenancyDeps } from '../../../packages/platform/src/control/tenancy/deps';
import { invitationMailKeys, ORG_INVITATION_MAILS_PER_DAY, RESEND_COOLDOWN_S, RESENDS_PER_INVITATION_PER_DAY } from '../../../packages/platform/src/control/tenancy/routes';
import { teamNamesFor } from '../../../packages/platform/src/control/tenancy/teams';
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

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

type Member = Record<string, unknown> & { userId: string; email: string; name: string; role: string; teams: { id: string; name: string }[] };

describe('member directory', () => {
  it('every member sees name, email, role and teams; only admins get join date, sign-in methods and inviter', async () => {
    const admin = await seedUser(fakes, { name: 'Ada Admin' });
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes, { name: 'Bob' });
    await addMember(orgId, bob);
    const team = await seedTeam(fakes, orgId, 'Eng', [bob]);
    // Bob came in through Ada's (accepted) invitation, has a Google account and two passkeys.
    const invId = crypto.randomUUID();
    await insertRow('invitation', {
      id: invId,
      organizationId: orgId,
      email: 'x',
      emailIndex: await fakes.ring.emailIndex(bob.email),
      role: 'tenant_user',
      status: 'accepted',
      inviterId: admin.id,
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    await insertRow('account', { id: crypto.randomUUID(), userId: bob.id, accountId: 'g-1', providerId: 'google', createdAt: now, updatedAt: now });
    for (let i = 0; i < 2; i++) {
      await insertRow('passkey', { id: crypto.randomUUID(), userId: bob.id, publicKey: 'pk', credentialID: `c${i}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, createdAt: now });
    }
    // A pending invitation: admin-only.
    await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'pending@example.com' } });

    const asUser = await json<{ members: Member[] }>(await call('GET', `/api/orgs/${orgId}/members`, { as: bob }));
    expect(asUser.members).toHaveLength(2);
    for (const m of asUser.members) {
      expect(Object.keys(m).sort()).toEqual(['email', 'name', 'role', 'teams', 'userId']);
    }
    expect(asUser.members.find((m) => m.userId === bob.id)).toEqual({ userId: bob.id, name: 'Bob', email: bob.email, role: 'tenant_user', teams: [{ id: team, name: 'Eng' }] });
    expect((await call('GET', `/api/orgs/${orgId}/invitations`, { as: bob })).status).toBe(403);

    const asAdmin = await json<{ members: Member[] }>(await call('GET', `/api/orgs/${orgId}/members`, { as: admin }));
    expect(asAdmin.members.find((m) => m.userId === bob.id)).toMatchObject({
      joinedAt: expect.any(String),
      signsInWith: { methods: ['email-otp', 'passkey', 'google'], passkeys: 2 },
      invitedBy: { userId: admin.id, name: 'Ada Admin' },
    });
    expect(asAdmin.members.find((m) => m.userId === admin.id)).toMatchObject({ signsInWith: { methods: ['email-otp'], passkeys: 0 }, invitedBy: null, teams: [] });

    // Non-members can't probe the directory.
    const outsider = await seedUser(fakes);
    expect((await call('GET', `/api/orgs/${orgId}/members`, { as: outsider })).status).toBe(404);
  });
});

describe('teams for members', () => {
  it('tenant users see names, counts and mine; grants only for admins; /teams/mine lists their own', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes);
    await addMember(orgId, bob);
    const eng = await seedTeam(fakes, orgId, 'Eng', [bob]);
    const ops = await seedTeam(fakes, orgId, 'Ops', [admin]);
    const inst = await seedInstance(orgId, { teams: [eng] });

    const asUser = await json<{ teams: Record<string, unknown>[] }>(await call('GET', `/api/orgs/${orgId}/teams`, { as: bob }));
    expect(asUser.teams).toEqual([
      { id: eng, name: 'Eng', members: 1, mine: true },
      { id: ops, name: 'Ops', members: 1, mine: false },
    ]);
    const asAdmin = await json<{ teams: Record<string, unknown>[] }>(await call('GET', `/api/orgs/${orgId}/teams`, { as: admin }));
    expect(asAdmin.teams[0]).toMatchObject({ id: eng, mine: false, instanceIds: [inst] });

    const mine = await json<{ teams: Record<string, unknown>[] }>(await call('GET', `/api/orgs/${orgId}/teams/mine`, { as: bob }));
    expect(mine.teams).toEqual([{ id: eng, name: 'Eng', members: 1, instanceIds: [inst] }]);

    // teamNamesFor: only this org's teams.
    const other = await seedOrg(fakes, await seedUser(fakes));
    const foreign = await seedTeam(fakes, other, 'Foreign');
    const names = await teamNamesFor(testEnv, orgId, [eng, ops, foreign, eng]);
    expect([...names.entries()].sort()).toEqual([[eng, 'Eng'], [ops, 'Ops']].sort());
  });
});

describe('per-team instance grants', () => {
  it('adds and removes one grant; removing drops sessions only of users without another granting team', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes);
    const carol = await seedUser(fakes);
    await addMember(orgId, bob);
    await addMember(orgId, carol);
    const eng = await seedTeam(fakes, orgId, 'Eng', [bob, carol]);
    const ops = await seedTeam(fakes, orgId, 'Ops', [carol]);
    const inst = await seedInstance(orgId, { teams: [ops] });
    const base = `/api/orgs/${orgId}/teams/${eng}/instances/${inst}`;

    expect((await call('POST', base, { as: bob })).status).toBe(403);
    expect(await json(await call('POST', base, { as: admin }))).toEqual({ ok: true, changed: true });
    expect(await json(await call('POST', base, { as: admin }))).toEqual({ ok: true, changed: false });
    const grants = await testEnv.DB.prepare('SELECT team_id FROM instance_teams WHERE instance_id = ? ORDER BY team_id').bind(inst).all<{ team_id: string }>();
    expect(grants.results.map((r) => r.team_id).sort()).toEqual([eng, ops].sort());

    expect(await json(await call('DELETE', base, { as: admin }))).toEqual({ ok: true, changed: true, droppedUsers: 1 });
    const calls = await gateCalls();
    expect(calls).toContainEqual(['dropSessions', inst, { userId: bob.id }]);
    expect(calls).not.toContainEqual(['dropSessions', inst, { userId: carol.id }]); // still has Ops
    expect(await json(await call('DELETE', base, { as: admin }))).toEqual({ ok: true, changed: false, droppedUsers: 0 });
    // D71: Ops is now the instance's only team.
    const last = await call('DELETE', `/api/orgs/${orgId}/teams/${ops}/instances/${inst}`, { as: admin });
    expect(last.status).toBe(409);
    expect(await json(last)).toEqual({ error: 'last_team' });
    const left = await testEnv.DB.prepare('SELECT team_id FROM instance_teams WHERE instance_id = ?').bind(inst).all<{ team_id: string }>();
    expect(left.results).toEqual([{ team_id: ops }]);

    const audit = await readOrgAudit(testEnv, orgId, { action: 'instance.teams_changed' });
    expect(audit.map((e) => e.details)).toEqual([
      { added: [], removed: [eng] },
      { added: [eng], removed: [] },
    ]);
  });

  it("refuses another org's team or instance", async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const team = await seedTeam(fakes, orgId, 'Eng');
    const otherAdmin = await seedUser(fakes);
    const other = await seedOrg(fakes, otherAdmin);
    const foreignInst = await seedInstance(other);
    const foreignTeam = await seedTeam(fakes, other, 'X');
    const mine = await seedInstance(orgId);
    expect((await call('POST', `/api/orgs/${orgId}/teams/${team}/instances/${foreignInst}`, { as: admin })).status).toBe(404);
    expect((await call('POST', `/api/orgs/${orgId}/teams/${foreignTeam}/instances/${mine}`, { as: admin })).status).toBe(404);
    expect((await call('DELETE', `/api/orgs/${orgId}/teams/${team}/instances/${foreignInst}`, { as: admin })).status).toBe(404);
  });
});

describe('invitations', () => {
  /** Better Auth's resend: an unexpired pending invitation for the address gets a new expiry. */
  function fakeResend(): { resent: string[] } {
    const seen = { resent: [] as string[] };
    const original = deps().auth;
    setTenancyDeps({
      auth: {
        ...original,
        async createInvitation(e, input) {
          if (input.resend) {
            const idx = await fakes.ring.emailIndex(input.email);
            const row = await e.DB.prepare("SELECT id FROM invitation WHERE organizationId = ? AND emailIndex = ? AND status = 'pending' AND expiresAt > ?")
              .bind(input.orgId, idx, new Date().toISOString())
              .first<{ id: string }>();
            if (row) {
              const expiresAt = Date.now() + 14 * 86_400_000;
              await e.DB.prepare('UPDATE invitation SET expiresAt = ? WHERE id = ?').bind(new Date(expiresAt).toISOString(), row.id).run();
              seen.resent.push(row.id);
              return { id: row.id, expiresAt };
            }
          }
          return original.createInvitation(e, input);
        },
      },
    });
    return seen;
  }

  it('refuses to invite a member or an address with an open invitation (409), not an expired one', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes);
    await addMember(orgId, bob);
    const invite = (email: string) => call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email } });
    const member = await invite(bob.email.toUpperCase());
    expect(member.status).toBe(409);
    expect(await json(member)).toEqual({ error: 'already_member' });
    const { id } = await json<{ id: string }>(await invite('twice@example.com'));
    const again = await invite('twice@example.com');
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: 'already_invited' });
    await testEnv.DB.prepare('UPDATE invitation SET expiresAt = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), id).run();
    expect((await invite('twice@example.com')).status).toBe(201);
  });

  it('lists the inviter by name; resend works at the member limit and extends the expiry', async () => {
    const admin = await seedUser(fakes, { name: 'Ada Admin' });
    const orgId = await seedOrg(fakes, admin);
    const seen = fakeResend();
    const ids: string[] = [];
    // 1 member + 9 pending = the free tier's 10.
    for (let i = 0; i < 9; i++) ids.push((await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: `p${i}@example.com` } }))).id);
    expect((await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'over@example.com' } })).status).toBe(409);

    const list = await json<{ invitations: { id: string; inviter: unknown; expiresAt: string }[] }>(await call('GET', `/api/orgs/${orgId}/invitations`, { as: admin }));
    const first = list.invitations.find((i) => i.id === ids[0]);
    expect(first?.inviter).toEqual({ userId: admin.id, name: 'Ada Admin' });

    const res = await call('POST', `/api/orgs/${orgId}/invitations/${ids[0]}/resend`, { as: admin });
    expect(res.status).toBe(200);
    const body = await json<{ id: string; expiresAt: number }>(res);
    expect(body.id).toBe(ids[0]);
    expect(body.expiresAt).toBeGreaterThan(new Date(first?.expiresAt ?? 0).getTime());
    expect(seen.resent).toEqual([ids[0]]);
    const audit = await readOrgAudit(testEnv, orgId, { action: 'invitation.resent' });
    expect(audit).toMatchObject([{ targetId: ids[0], details: { email: 'p0@example.com' } }]);

    // Tenant users can't; canceled or foreign invitations are 404.
    const bob = await seedUser(fakes);
    await addMember(orgId, bob);
    expect((await call('POST', `/api/orgs/${orgId}/invitations/${ids[1]}/resend`, { as: bob })).status).toBe(403);
    await call('DELETE', `/api/orgs/${orgId}/invitations/${ids[2]}`, { as: admin });
    expect((await call('POST', `/api/orgs/${orgId}/invitations/${ids[2]}/resend`, { as: admin })).status).toBe(404);
    const otherAdmin = await seedUser(fakes);
    const other = await seedOrg(fakes, otherAdmin);
    expect((await call('POST', `/api/orgs/${other}/invitations/${ids[1]}/resend`, { as: otherAdmin })).status).toBe(404);
  });

  it('an expired invitation is replaced by a new one and the old one canceled', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    fakeResend();
    const { id } = await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'late@example.com' } }));
    await testEnv.DB.prepare('UPDATE invitation SET expiresAt = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), id).run();
    const list = await json<{ invitations: { id: string; expired: boolean }[] }>(await call('GET', `/api/orgs/${orgId}/invitations`, { as: admin }));
    expect(list.invitations).toMatchObject([{ id, expired: true }]);

    const res = await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/invitations/${id}/resend`, { as: admin }));
    expect(res.id).not.toBe(id);
    const rows = await testEnv.DB.prepare('SELECT id, status FROM invitation WHERE organizationId = ? ORDER BY createdAt').bind(orgId).all<{ id: string; status: string }>();
    expect(rows.results).toEqual(expect.arrayContaining([{ id, status: 'canceled' }, { id: res.id, status: 'pending' }]));
  });

  describe('mail limits', () => {
    it('one resend per 5 minutes and 5 a day per invitation', async () => {
      const admin = await seedUser(fakes);
      const orgId = await seedOrg(fakes, admin);
      fakeResend();
      const { id } = await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'slow@example.com' } }));
      const resend = () => call('POST', `/api/orgs/${orgId}/invitations/${id}/resend`, { as: admin });
      expect((await resend()).status).toBe(200);
      const again = await resend();
      expect(again.status).toBe(429);
      expect(await json(again)).toEqual({ error: 'resend_too_soon' });

      // Past the cooldown (its stamp moved back), the per-day count still caps it.
      const idx = (await testEnv.DB.prepare('SELECT emailIndex FROM invitation WHERE id = ?').bind(id).first<{ emailIndex: string }>())!.emailIndex;
      const keys = invitationMailKeys(orgId, idx);
      const pastCooldown = () => testEnv.KV.put(keys.cooldown, String(Date.now() - RESEND_COOLDOWN_S * 1000 - 1), { expirationTtl: 60 });
      for (let n = 2; n <= RESENDS_PER_INVITATION_PER_DAY; n++) {
        await pastCooldown();
        expect((await resend()).status).toBe(200);
      }
      await pastCooldown();
      const capped = await resend();
      expect(capped.status).toBe(429);
      expect(await json(capped)).toEqual({ error: 'invitation_mail_limit' });
      expect(await testEnv.KV.get(keys.resends)).toBe(String(RESENDS_PER_INVITATION_PER_DAY));
      // 1 create + 5 resends counted for the org; refused attempts aren't.
      expect(await testEnv.KV.get(keys.org)).toBe(String(1 + RESENDS_PER_INVITATION_PER_DAY));
    });

    it('at most 50 invitation mails per org per UTC day across create and resend', async () => {
      const admin = await seedUser(fakes);
      const orgId = await seedOrg(fakes, admin);
      fakeResend();
      const { id } = await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'first@example.com' } }));
      const keys = invitationMailKeys(orgId, 'x');
      await testEnv.KV.put(keys.org, String(ORG_INVITATION_MAILS_PER_DAY - 1));
      // The 50th goes out; the 51st (create or resend) is refused before anything is created.
      expect((await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'fiftieth@example.com' } })).status).toBe(201);
      const create = await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'over@example.com' } });
      expect(create.status).toBe(429);
      expect(await json(create)).toEqual({ error: 'invitation_mail_limit' });
      const resend = await call('POST', `/api/orgs/${orgId}/invitations/${id}/resend`, { as: admin });
      expect(await json(resend)).toEqual({ error: 'invitation_mail_limit' });
      const pending = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM invitation WHERE organizationId = ? AND status = 'pending'").bind(orgId).first<{ n: number }>();
      expect(pending?.n).toBe(2);
      // Another org is unaffected.
      const otherAdmin = await seedUser(fakes);
      const other = await seedOrg(fakes, otherAdmin);
      expect((await call('POST', `/api/orgs/${other}/invitations`, { as: otherAdmin, body: { email: 'elsewhere@example.com' } })).status).toBe(201);
    });
  });
});

describe('audit filters', () => {
  it('org log: action prefix, actor and category, with before/limit paging', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const other = await seedUser(fakes);
    const ev = (action: Parameters<typeof auditOrg>[2]['action'], actorId: string) =>
      auditOrg(testEnv, orgId, { actorId, actorScope: 'tenant', action, targetType: 'org', targetId: orgId });
    await ev('instance.created', admin.id);
    await ev('instance.renamed', other.id);
    await ev('member.role_changed', admin.id);
    await ev('team.created', other.id);
    await ev('org.key_rotated', admin.id);
    await ev('org.renamed', admin.id);

    const get = async (qs: string) => {
      const res = await call('GET', `/api/orgs/${orgId}/audit?${qs}`, { as: admin });
      expect(res.status).toBe(200);
      return (await json<{ entries: { action: string; category: string; at: number }[] }>(res)).entries;
    };
    expect((await get('action=instance.')).map((e) => e.action).sort()).toEqual(['instance.created', 'instance.renamed']);
    expect((await get(`actorId=${other.id}`)).map((e) => e.action).sort()).toEqual(['instance.renamed', 'team.created']);
    expect((await get(`action=instance.&actorId=${other.id}`)).map((e) => e.action)).toEqual(['instance.renamed']);
    expect((await get('category=members')).map((e) => e.action).sort()).toEqual(['member.role_changed', 'team.created']);
    expect((await get('category=security')).map((e) => e.action)).toEqual(['org.key_rotated']);
    expect((await get('category=settings')).map((e) => e.action)).toEqual(['org.renamed']);
    expect((await get('category=instances')).every((e) => e.category === 'instances')).toBe(true);
    // '_' in the prefix is literal, not a LIKE wildcard.
    expect(await get('action=member_')).toEqual([]);

    const page = await get('limit=2');
    expect(page).toHaveLength(2);
    const rest = await get(`before=${page[1]?.at}&limit=10`);
    expect(rest.every((e) => e.at < (page[1]?.at ?? 0))).toBe(true);

    expect((await call('GET', `/api/orgs/${orgId}/audit?category=bogus`, { as: admin })).status).toBe(400);
    expect((await call('GET', `/api/orgs/${orgId}/audit?action=x%25`, { as: admin })).status).toBe(400);
  });

  it('platform log: same filters for audit.view holders', async () => {
    const staff = await seedUser(fakes);
    await grantPlatformRole(staff, 'admin');
    const marker = crypto.randomUUID();
    await auditPlatform(testEnv, { actorId: marker, actorRole: 'admin', action: 'platform.code_created', targetType: 'code', targetId: 'c1' });
    await auditPlatform(testEnv, { actorId: marker, actorRole: 'admin', action: 'platform.role_granted', targetType: 'user', targetId: 'u1' });
    await auditPlatform(testEnv, { actorId: marker, actorRole: 'admin', action: 'org.tier_changed', targetType: 'org', targetId: 'o1' });

    const res = await call('GET', `/api/platform/audit?actorId=${marker}&category=security`, { as: staff, mfa: true });
    expect(res.status).toBe(200);
    const body = await json<{ entries: { action: string; actorRole: string; category: string }[]; lostWritesToday: number }>(res);
    expect(body.entries).toMatchObject([{ action: 'platform.role_granted', actorRole: 'admin', category: 'security' }]);
    expect(body.lostWritesToday).toBe(0);
    expect((await readPlatformAudit(testEnv, { actorId: marker, action: 'platform.' })).map((e) => e.action).sort()).toEqual(['platform.code_created', 'platform.role_granted']);
    expect((await readPlatformAudit(testEnv, { actorId: marker, category: 'settings' })).map((e) => e.action)).toEqual(['org.tier_changed']);
    expect((await call('GET', `/api/platform/audit?category=nope`, { as: staff, mfa: true })).status).toBe(400);
  });

  it('every known action has exactly one category', () => {
    expect(auditCategoryOf('instance.deleted')).toBe('instances');
    expect(auditCategoryOf('invitation.resent')).toBe('members');
    expect(auditCategoryOf('auth.signed_in')).toBe('security');
    expect(auditCategoryOf('platform.worca_version_set')).toBe('settings');
  });
});

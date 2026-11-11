// GET /api/me additions (ui-feasibility.md T3, T14): per-org usable instance counts and the
// "signs in with" summary.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  ensureTables,
  harness,
  insertRow,
  installFakes,
  seedInstance,
  seedOrg,
  seedTeam,
  seedUser,
  testEnv,
  type Fakes,
} from './helpers/tenancy-fixtures';

let fakes: Fakes;
const call = harness();

interface MeOrg {
  id: string;
  role: string;
  instances: number;
}
interface Me {
  orgs: MeOrg[];
  signIn: { emailCode: boolean; passkeys: number; providers: string[]; available: string[] };
}

const me = async (as: Awaited<ReturnType<typeof seedUser>>) => {
  const res = await call('GET', '/api/me', { as });
  expect(res.status).toBe(200);
  return (await res.json()) as Me;
};

beforeAll(async () => {
  await ensureTables();
});

beforeEach(() => {
  fakes = installFakes();
});

describe('GET /api/me: instances per org (T3)', () => {
  it('admins count every live instance; users only those granted to their teams in that org', async () => {
    const admin = await seedUser(fakes);
    const user = await seedUser(fakes);
    const outsider = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    await addMember(orgId, user, 'tenant_user');
    const teamA = await seedTeam(fakes, orgId, 'A', [user]);
    const teamB = await seedTeam(fakes, orgId, 'B', [admin]);
    await seedInstance(orgId, { teams: [teamA] });
    await seedInstance(orgId, { teams: [teamA, teamB] }); // counted once
    await seedInstance(orgId, { teams: [teamB] });
    await seedInstance(orgId); // no team
    await seedInstance(orgId, { status: 'deleting', teams: [teamA] });

    // A second org: the user's team there must not count for the first, and vice versa.
    const otherOrg = await seedOrg(fakes, outsider, 'Other');
    await addMember(otherOrg, user, 'tenant_user');
    const foreignTeam = await seedTeam(fakes, otherOrg, 'F', [user]);
    await seedInstance(otherOrg, { teams: [foreignTeam] });
    // An instance of the first org tied to a team of the other org (shouldn't happen, D19) is not usable.
    await seedInstance(orgId, { teams: [foreignTeam] });

    const forAdmin = (await me(admin)).orgs.find((o) => o.id === orgId)!;
    expect(forAdmin.instances).toBe(5); // all but the deleting one
    const forUser = await me(user);
    expect(forUser.orgs.find((o) => o.id === orgId)!.instances).toBe(2);
    expect(forUser.orgs.find((o) => o.id === otherOrg)!.instances).toBe(1);
    expect((await me(outsider)).orgs.map((o) => o.id)).toEqual([otherOrg]);
    for (const o of forUser.orgs) expect(Object.keys(o).sort()).toEqual(['id', 'instances', 'joinedAt', 'name', 'role']);
  });

  it('a user in no team sees zero', async () => {
    const admin = await seedUser(fakes);
    const user = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    await addMember(orgId, user, 'tenant_user');
    await seedInstance(orgId);
    expect((await me(user)).orgs[0]!.instances).toBe(0);
  });
});

describe('GET /api/me: signs in with (T14)', () => {
  it('email code always; passkey count and linked providers from the caller’s own rows', async () => {
    const user = await seedUser(fakes);
    const other = await seedUser(fakes);
    expect((await me(user)).signIn).toEqual({ emailCode: true, passkeys: 0, providers: [], available: [] });

    const now = new Date().toISOString();
    const account = (userId: string, providerId: string) =>
      insertRow('account', { id: crypto.randomUUID(), userId, accountId: crypto.randomUUID(), providerId, createdAt: now, updatedAt: now });
    await account(user.id, 'credential');
    await account(user.id, 'google');
    await account(user.id, 'acme-okta'); // an org SSO provider id
    await account(other.id, 'microsoft');
    const passkey = (userId: string) =>
      insertRow('passkey', {
        id: crypto.randomUUID(),
        name: 'k',
        publicKey: 'pk',
        userId,
        credentialID: crypto.randomUUID(),
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: 0,
        createdAt: now,
      });
    await passkey(user.id);
    await passkey(user.id);
    await passkey(other.id);

    expect((await me(user)).signIn).toEqual({ emailCode: true, passkeys: 2, providers: ['google', 'sso'], available: [] });
    expect((await me(other)).signIn).toEqual({ emailCode: true, passkeys: 1, providers: ['microsoft'], available: [] });
  });

  it('available: the social providers this deployment has credentials for', async () => {
    const user = await seedUser(fakes);
    const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, testEnv[k]]));
    const set = (vals: Partial<Record<(typeof keys)[number], string>>) => {
      for (const k of keys) (testEnv as unknown as Record<string, string | undefined>)[k] = vals[k];
    };
    try {
      set({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g' });
      expect((await me(user)).signIn.available).toEqual(['google']);
      set({ GOOGLE_CLIENT_ID: 'g', MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 'm' }); // Google without its secret
      expect((await me(user)).signIn.available).toEqual(['microsoft']);
      set({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'g', MICROSOFT_CLIENT_ID: 'm', MICROSOFT_CLIENT_SECRET: 'm' });
      expect((await me(user)).signIn.available).toEqual(['google', 'microsoft']);
    } finally {
      set(saved as Partial<Record<(typeof keys)[number], string>>);
    }
  });

  it('GET /api/me/passkeys and /api/me/sessions need a signed-in caller', async () => {
    expect((await call('GET', '/api/me/passkeys')).status).toBe(401);
    expect((await call('GET', '/api/me/sessions')).status).toBe(401);
    expect((await call('POST', '/api/me/sessions/revoke-others')).status).toBe(401);
    expect((await call('DELETE', '/api/me/sessions/r1.x.1.y')).status).toBe(401);
  });
});

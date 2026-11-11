import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { can, CAPABILITIES, type Capability } from '../../../packages/platform/src/control/tenancy/roles';
import { addMember, ensureTables, type Fakes, grantPlatformRole, harness, installFakes, seedOrg, seedUser } from './helpers/tenancy-fixtures';

let fakes: Fakes;
const call = harness();

beforeAll(ensureTables);
beforeEach(() => {
  fakes = installFakes();
});

describe('capability matrix (D14)', () => {
  it('superadmin holds every capability; admin all but system, roles, master key and access requests; support only view', () => {
    const all = Object.keys(CAPABILITIES) as Capability[];
    expect(all.every((c) => can(['superadmin'], c))).toBe(true);
    expect(all.filter((c) => !can(['admin'], c)).sort()).toEqual(['access_requests.manage', 'keys.master', 'roles.manage', 'system.settings']);
    expect(all.filter((c) => can(['support'], c))).toEqual(['platform.view']);
    expect(all.some((c) => can([], c))).toBe(false);
  });
});

describe('requireCap', () => {
  it('401 without a session, 403 without the role, 403 mfa_required without MFA (D24)', async () => {
    expect((await call('GET', '/api/platform/orgs')).status).toBe(401);
    const nobody = await seedUser(fakes);
    expect((await call('GET', '/api/platform/orgs', { as: nobody, mfa: true })).status).toBe(403);
    const support = await seedUser(fakes);
    await grantPlatformRole(support, 'support');
    const noMfa = await call('GET', '/api/platform/orgs', { as: support });
    expect(noMfa.status).toBe(403);
    expect(await noMfa.json()).toEqual({ error: 'mfa_required' });
    expect((await call('GET', '/api/platform/orgs', { as: support, mfa: true })).status).toBe(200);
    expect((await call('GET', '/api/platform/audit', { as: support, mfa: true })).status).toBe(403);
  });
});

describe('requireOrgRole', () => {
  it('404 for non-members, also platform superadmins (D15); 403 for tenant users on admin routes', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin, 'Acme');
    const outsider = await seedUser(fakes);
    await grantPlatformRole(outsider, 'superadmin');
    expect((await call('GET', `/api/orgs/${orgId}`, { as: outsider, mfa: true })).status).toBe(404);
    expect((await call('GET', `/api/orgs/${orgId}/audit`, { as: outsider, mfa: true })).status).toBe(404);

    const user = await seedUser(fakes);
    await addMember(orgId, user, 'tenant_user');
    expect((await call('GET', `/api/orgs/${orgId}`, { as: user })).status).toBe(200);
    expect((await call('GET', `/api/orgs/${orgId}/audit`, { as: user })).status).toBe(403);
    expect((await call('GET', `/api/orgs/${orgId}/audit`, { as: admin })).status).toBe(200);
  });

  it('refuses pending accounts', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const pending = { ...admin, status: 'pending' as const };
    expect((await call('GET', `/api/orgs/${orgId}`, { as: pending })).status).toBe(403);
  });
});

describe('platform role bindings', () => {
  it('superadmin grants and revokes; admin cannot; no self changes; last superadmin stays', async () => {
    const root = await seedUser(fakes);
    await grantPlatformRole(root, 'superadmin');
    const admin = await seedUser(fakes);
    await grantPlatformRole(admin, 'admin');
    const target = await seedUser(fakes, { email: 'Target@Example.com' });

    expect((await call('POST', '/api/platform/roles', { as: admin, mfa: true, body: { userId: target.id, role: 'support' } })).status).toBe(403);
    // By exact email through the blind index.
    const granted = await call('POST', '/api/platform/roles', { as: root, mfa: true, body: { email: 'target@example.com', role: 'support' } });
    expect(granted.status).toBe(201);
    expect(((await granted.json()) as { userId: string }).userId).toBe(target.id);
    expect((await call('POST', '/api/platform/roles', { as: root, mfa: true, body: { userId: root.id, role: 'admin' } })).status).toBe(403);

    // Count every superadmin in this database, then remove all but root through the API.
    const others = await import('cloudflare:test').then(({ env }) =>
      env.DB.prepare("SELECT user_id FROM platform_roles WHERE role = 'superadmin' AND user_id != ?").bind(root.id).all<{ user_id: string }>(),
    );
    const second = await seedUser(fakes);
    await grantPlatformRole(second, 'superadmin');
    for (const o of others.results) await call('DELETE', `/api/platform/roles/${o.user_id}/superadmin`, { as: second, mfa: true });
    // root is now one of two; second may remove root, and then nobody may remove second.
    expect((await call('DELETE', `/api/platform/roles/${root.id}/superadmin`, { as: second, mfa: true })).status).toBe(200);
    await grantPlatformRole(root, 'admin');
    const last = await call('DELETE', `/api/platform/roles/${second.id}/superadmin`, { as: second, mfa: true });
    expect(last.status).toBe(403); // self change
    expect((await call('DELETE', `/api/platform/roles/${target.id}/support`, { as: second, mfa: true })).status).toBe(200);
    expect((await call('DELETE', `/api/platform/roles/${target.id}/support`, { as: second, mfa: true })).status).toBe(404);
  });
});

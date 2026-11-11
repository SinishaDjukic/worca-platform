import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { ensureTables, type Fakes, grantPlatformRole, harness, installFakes, seedInstance, seedOrg, seedUser, testEnv, type TestUser } from './helpers/tenancy-fixtures';

let fakes: Fakes;
let root: TestUser;
let admin: TestUser;
let support: TestUser;
const call = harness();

beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  root = await seedUser(fakes);
  await grantPlatformRole(root, 'superadmin');
  admin = await seedUser(fakes);
  await grantPlatformRole(admin, 'admin');
  support = await seedUser(fakes);
  await grantPlatformRole(support, 'support');
});

const as = (u: TestUser) => ({ as: u, mfa: true });

describe('platform console (D15)', () => {
  it('lists orgs and instances with counts, status and names, never tenant content', async () => {
    const owner = await seedUser(fakes);
    const orgId = await seedOrg(fakes, owner, 'Secret Corp');
    const inst = await seedInstance(orgId);
    await testEnv.DB.prepare('INSERT OR REPLACE INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, ?, ?, ?, ?, NULL, 1)')
      .bind(inst, Date.now(), 'ok', '1.8.0', '{"running":2}')
      .run();
    const orgsRes = await call('GET', '/api/platform/orgs?limit=500', as(support));
    // Org names are shown to platform staff (product decision 2026-10-06, P5).
    const orgs = ((await orgsRes.json()) as { orgs: { id: string; members: number; instances: number; tier: string }[] }).orgs;
    expect(orgs.find((o) => o.id === orgId)).toMatchObject({ name: 'Secret Corp', members: 1, instances: 1, tier: 'free' });
    const insts = (await (await call('GET', `/api/platform/instances?orgId=${orgId}`, as(support))).json()) as { instances: Record<string, unknown>[] };
    expect(insts.instances).toEqual([expect.objectContaining({ id: inst, status: 'running', version: '1.8.0', pipelines: { running: 2 } })]);
    expect(insts.instances[0]).not.toHaveProperty('display_name');
  });

  it('stop and lift go through the instances module; support may not', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    const inst = await seedInstance(orgId);
    expect((await call('POST', `/api/platform/instances/${inst}/stop`, { ...as(support), body: { reason: 'spam' } })).status).toBe(403);
    expect((await call('POST', `/api/platform/instances/${inst}/stop`, { ...as(admin), body: { reason: 'spam' } })).status).toBe(200);
    expect((await call('POST', `/api/platform/instances/${inst}/lift`, as(admin))).status).toBe(200);
    expect(fakes.instanceCalls).toEqual([
      ['stopForAbuse', inst, { actorId: admin.id, reason: 'spam', actorRole: 'admin' }],
      ['liftStop', inst, { actorId: admin.id, actorRole: 'admin' }],
    ]);
    expect((await call('POST', `/api/platform/instances/${crypto.randomUUID()}/lift`, as(admin))).status).toBe(404);
  });

  it('sets an org tier, audited in both logs', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    await testEnv.DB.prepare("INSERT OR IGNORE INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members) VALUES ('pro', 'Pro', 3, 4, 8192, 50, 50)").run();
    expect((await call('PUT', `/api/platform/orgs/${orgId}/tier`, { ...as(admin), body: { tier: 'nope' } })).status).toBe(400);
    expect((await call('PUT', `/api/platform/orgs/${orgId}/tier`, { ...as(admin), body: { tier: 'pro' } })).status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT actor_scope FROM audit_org WHERE org_id = ? AND action = ?').bind(orgId, 'org.tier_changed').first<{ actor_scope: string }>();
    expect(row?.actor_scope).toBe('platform');
  });
});

describe('tiers and compute sizes (D78)', () => {
  const tierBody = { name: 'Agency', instancesPerOrg: 20, members: 100, volumeGb: 10, sizes: ['xl', 'standard'], defaultSize: 'standard' };

  it('lists Free, Team and Business with their sizes, the compute sizes and the default tier', async () => {
    const res = (await (await call('GET', '/api/platform/tiers', as(support))).json()) as {
      tiers: { id: string; instances_per_org: number; members: number; sizes: string[]; default_size: string; orgs: number }[];
      computeSizes: { id: string; vcpu: number }[];
      defaultTier: string;
    };
    const byId = Object.fromEntries(res.tiers.map((t) => [t.id, t]));
    expect(byId.free).toMatchObject({ instances_per_org: 1, members: 10, sizes: ['standard'], default_size: 'standard' });
    expect(byId.team).toMatchObject({ instances_per_org: 5, members: 25, sizes: ['standard', 'large'] });
    expect(byId.business).toMatchObject({ instances_per_org: 10, members: 50, sizes: ['standard', 'large', 'xl'] });
    expect(res.computeSizes.map((s) => [s.id, s.vcpu])).toEqual([['standard', 2], ['large', 4], ['xl', 8]]);
    expect(res.defaultTier).toBe('free');
  });

  it('superadmins create, change and delete tiers; admins may not; audited', async () => {
    const id = `t-${crypto.randomUUID().slice(0, 8)}`;
    expect((await call('POST', '/api/platform/tiers', { ...as(admin), body: { ...tierBody, id } })).status).toBe(403);
    expect((await call('POST', '/api/platform/tiers', { ...as(root), body: { ...tierBody, id, defaultSize: 'large' } })).status).toBe(400);
    expect((await call('POST', '/api/platform/tiers', { ...as(root), body: { ...tierBody, id: 'Bad Id' } })).status).toBe(400);
    expect((await call('POST', '/api/platform/tiers', { ...as(root), body: { ...tierBody, id } })).status).toBe(201);
    expect((await call('POST', '/api/platform/tiers', { ...as(root), body: { ...tierBody, id } })).status).toBe(409);
    const row = await testEnv.DB.prepare('SELECT * FROM tiers WHERE id = ?').bind(id).first<Record<string, unknown>>();
    // Sizes kept in the sizes' own order; vcpu and memory_mb follow the default size.
    expect(row).toMatchObject({ name: 'Agency', instances_per_org: 20, members: 100, sizes: '["standard","xl"]', default_size: 'standard', vcpu: 2, memory_mb: 4096 });

    expect((await call('PUT', `/api/platform/tiers/${id}`, { ...as(root), body: { ...tierBody, instancesPerOrg: 30, defaultSize: 'xl' } })).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT instances_per_org, default_size, vcpu FROM tiers WHERE id = ?').bind(id).first()).toEqual({ instances_per_org: 30, default_size: 'xl', vcpu: 8 });
    expect((await call('PUT', '/api/platform/tiers/nope', { ...as(root), body: tierBody })).status).toBe(404);

    // In use by an org: kept.
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    await call('PUT', `/api/platform/orgs/${orgId}/tier`, { ...as(admin), body: { tier: id } });
    expect(await call('DELETE', `/api/platform/tiers/${id}`, as(root)).then((r) => r.json())).toEqual({ error: 'tier_in_use' });
    await call('PUT', `/api/platform/orgs/${orgId}/tier`, { ...as(admin), body: { tier: 'free' } });
    expect((await call('DELETE', `/api/platform/tiers/${id}`, as(root))).status).toBe(200);
    expect((await call('DELETE', '/api/platform/tiers/free', as(root))).status).toBe(409); // the default for new orgs
    const actions = (await testEnv.DB.prepare('SELECT action FROM audit_platform WHERE target_id = ? ORDER BY at').bind(id).all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(['platform.tier_created', 'platform.tier_updated', 'platform.tier_deleted']);
  });

  it('the org view has the tier limits; instances on a size the tier no longer allows are flagged', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    const inst = await seedInstance(orgId);
    await testEnv.DB.prepare("UPDATE instances SET compute_size = 'xl' WHERE id = ?").bind(inst).run();
    const org = (await (await call('GET', `/api/platform/orgs/${orgId}`, as(support))).json()) as Record<string, any>;
    expect(org).toMatchObject({ tier: 'free', tierName: 'Free', instanceLimit: 1, memberLimit: 10, tierSizes: ['standard'] });
    expect(org.instances[0]).toMatchObject({ size: 'xl', aboveTier: 1 });
    const list = (await (await call('GET', `/api/platform/instances?orgId=${orgId}`, as(support))).json()) as { instances: Record<string, unknown>[] };
    expect(list.instances[0]).toMatchObject({ size: 'xl', aboveTier: 1 });
    await call('PUT', `/api/platform/orgs/${orgId}/tier`, { ...as(admin), body: { tier: 'business' } });
    const one = (await (await call('GET', `/api/platform/instances/${inst}`, as(support))).json()) as Record<string, any>;
    expect(one).toMatchObject({ aboveTier: 0, computeSize: { id: 'xl', vcpu: 8, pending: false } });
  });

  it('stats count Railway services against the workspace cap', async () => {
    const stats = (await (await call('GET', '/api/platform/stats', as(support))).json()) as { capacity: Record<string, unknown> };
    const n = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM instances').first<{ n: number }>())!.n;
    // The (fake) provider describes itself like Railway: three services per instance, 100 per workspace.
    expect(stats.capacity).toEqual({ unit: 'services', used: n * 3, limit: 100, services: n * 3, cap: 100 });
  });
});

describe('registration (D25)', () => {
  it('mode is a superadmin setting; codes are admin work and stored only as hashes', async () => {
    expect((await call('PUT', '/api/platform/registration', { ...as(admin), body: { mode: 'open' } })).status).toBe(403);
    expect((await call('PUT', '/api/platform/registration', { ...as(root), body: { mode: 'waitlist' } })).status).toBe(200);
    expect(await (await call('GET', '/api/platform/registration', as(support))).json()).toEqual({ mode: 'waitlist' });
    await call('PUT', '/api/platform/registration', { ...as(root), body: { mode: 'invite_code' } });

    const created = (await (await call('POST', '/api/platform/registration/codes', { ...as(admin), body: { uses: 3 } })).json()) as { code: string; id: string };
    expect(created.id).toBe(await sha256Hex(created.code));
    const row = await testEnv.DB.prepare('SELECT uses_left FROM registration_codes WHERE code_hash = ?').bind(created.id).first<{ uses_left: number }>();
    expect(row?.uses_left).toBe(3);
    const list = await (await call('GET', '/api/platform/registration/codes', as(admin))).text();
    expect(list).not.toContain(created.code);
    expect((await call('DELETE', `/api/platform/registration/codes/${created.id}`, as(admin))).status).toBe(200);
    expect((await call('DELETE', `/api/platform/registration/codes/${created.id}`, as(admin))).status).toBe(404);
  });

  it('waitlist approve activates; reject deletes the pending account', async () => {
    const a = await seedUser(fakes, { status: 'pending' });
    const b = await seedUser(fakes, { status: 'pending' });
    const list = (await (await call('GET', '/api/platform/waitlist', as(admin))).json()) as { pending: { id: string }[] };
    expect(list.pending.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await call('POST', `/api/platform/waitlist/${a.id}/approve`, as(admin))).status).toBe(200);
    expect((await testEnv.DB.prepare('SELECT status FROM user WHERE id = ?').bind(a.id).first<{ status: string }>())?.status).toBe('active');
    expect(fakes.mail.at(-1)?.to).toBe(a.email);
    expect((await call('POST', `/api/platform/waitlist/${a.id}/approve`, as(admin))).status).toBe(404);
    expect((await call('POST', `/api/platform/waitlist/${b.id}/reject`, as(admin))).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT 1 FROM user WHERE id = ?').bind(b.id).first()).toBeNull();
    expect(fakes.ring.destroyed.has(`user:${b.id}`)).toBe(true);
  });

  it('platform audit log is readable by admins, not support', async () => {
    expect((await call('GET', '/api/platform/audit', as(support))).status).toBe(403);
    await call('PUT', '/api/platform/registration', { ...as(root), body: { mode: 'invite_code' } });
    const log = (await (await call('GET', '/api/platform/audit', as(admin))).json()) as { entries: { action: string }[] };
    expect(log.entries.map((e) => e.action)).toContain('platform.registration_mode_set');
  });
});

describe('waitlist', () => {
  it('lists waiting accounts with name and address for approvers, and audits the listing', async () => {
    const waiting = await seedUser(fakes, { status: 'pending', registeredVia: 'waitlist', name: 'Wanda Wait' });
    expect((await call('GET', '/api/platform/waitlist', as(support))).status).toBe(403);
    const res = await call('GET', '/api/platform/waitlist', as(admin));
    expect(res.status).toBe(200);
    const { pending } = (await res.json()) as { pending: { id: string; name: string | null; email: string | null }[] };
    expect(pending.find((p) => p.id === waiting.id)).toMatchObject({ name: 'Wanda Wait', email: waiting.email });
    const audit = await testEnv.DB.prepare("SELECT actor_id AS actorId, details FROM audit_platform WHERE action = 'platform.waitlist_viewed' ORDER BY at DESC LIMIT 1").first<{ actorId: string; details: string }>();
    expect(audit?.actorId).toBe(admin.id);
    expect(audit?.details).not.toContain(waiting.email);
  });
});

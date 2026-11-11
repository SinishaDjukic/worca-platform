// Platform console additions (ui-feasibility.md P1, P3, P5-P7, P10-P12) and the waitlist fix.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isPublishedVersion } from '../../../packages/platform/src/control/instances/images';
import { setTenancyDeps } from '../../../packages/platform/src/control/tenancy/deps';
import { fakeRegistry } from './fake-registry';
import { setInstancesDeps } from '../../../packages/platform/src/control/instances/deps';
import { addMember, ensureTables, type Fakes, grantPlatformRole, harness, insertRow, installFakes, seedInstance, seedOrg, seedUser, testEnv, type TestUser } from './helpers/tenancy-fixtures';

let fakes: Fakes;
let root: TestUser;
let admin: TestUser;
let support: TestUser;
const call = harness();
const as = (u: TestUser) => ({ as: u, mfa: true });
const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  root = await seedUser(fakes, { name: 'Root Person', email: `root-${crypto.randomUUID().slice(0, 6)}@staff.test` });
  await grantPlatformRole(root, 'superadmin');
  admin = await seedUser(fakes);
  await grantPlatformRole(admin, 'admin');
  support = await seedUser(fakes);
  await grantPlatformRole(support, 'support');
});

async function seedNamedInstance(orgId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await insertRow('instances', {
    id,
    org_id: orgId,
    slug: id.slice(0, 10),
    key_slug: id.slice(-10),
    display_name: await fakes.ring.encrypt({ table: 'instances', column: 'display_name', rowId: id, owner: { type: 'org', id: orgId } }, name),
    status: 'running',
    worca_version: '1.8.0',
    health: 'ok',
    last_heartbeat_at: now,
    created_at: now,
    updated_at: now,
    ...extra,
  });
  return id;
}

describe('orgs with names (P5)', () => {
  it('lists names and shows one org with its admins and instances', async () => {
    const founder = await seedUser(fakes, { email: 'founder@acme.test' });
    const orgId = await seedOrg(fakes, founder, 'Acme Rockets');
    const second = await seedUser(fakes, { email: 'second@acme.test' });
    await addMember(orgId, second, 'tenant_admin');
    await addMember(orgId, await seedUser(fakes), 'tenant_user');
    const inst = await seedNamedInstance(orgId, 'Main line', { health: 'degraded' });

    const list = await json<{ orgs: { id: string; name: string | null }[] }>(call('GET', '/api/platform/orgs?limit=500', as(support)));
    expect(list.orgs.find((o) => o.id === orgId)?.name).toBe('Acme Rockets');
    expect(JSON.stringify(list)).not.toContain('encName');

    const org = await json<Record<string, unknown>>(call('GET', `/api/platform/orgs/${orgId}`, as(support)));
    expect(org).toMatchObject({
      id: orgId,
      name: 'Acme Rockets',
      tier: 'free',
      status: 'active',
      members: 3,
      firstAdmin: { userId: founder.id, email: 'founder@acme.test' },
      admins: [
        { userId: founder.id, email: 'founder@acme.test' },
        { userId: second.id, email: 'second@acme.test' },
      ],
      instances: [{ id: inst, name: 'Main line', status: 'running', version: '1.8.0', health: 'degraded', lastHeartbeatAt: expect.any(Number) }],
    });
    expect(JSON.stringify(org)).not.toContain('enc:v1');
    expect((await call('GET', `/api/platform/orgs/${crypto.randomUUID()}`, as(support))).status).toBe(404);
  });

  it('a destroyed org key shows a null name rather than failing', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes), 'Gone Inc');
    await fakes.ring.destroyKey({ type: 'org', id: orgId });
    const org = await json<{ name: string | null }>(call('GET', `/api/platform/orgs/${orgId}`, as(support)));
    expect(org.name).toBeNull();
  });
});

describe('instance detail (P6)', () => {
  it('returns size, region, provider ids and names, never a secret', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes), 'Detail Org');
    const id = await seedNamedInstance(orgId, 'Prod box', {
      cpu: 2,
      memory_mb: 4096,
      volume_gb: 10,
      compute_ref: JSON.stringify({ projectId: 'p1', environmentId: 'e1', services: { worca: { serviceId: 's1', deploymentId: 'd1' }, broker: { serviceId: 's2', apiToken: 'leak-1' } }, token: 'leak-2' }),
      edge_ref: JSON.stringify({ tunnelId: 't1', dnsRecordIds: ['r1', 'r2'], tunnelToken: 'leak-3' }),
    });
    const res = await call('GET', `/api/platform/instances/${id}`, as(support));
    const text = await res.clone().text();
    expect(text).not.toMatch(/leak-|enc:v1/);
    expect(await res.json()).toMatchObject({
      id,
      orgId,
      name: 'Prod box',
      orgName: 'Detail Org',
      url: `http://${id.slice(0, 10)}.run.localhost:8798`,
      keyUrl: `http://${id.slice(-10)}.run.localhost:8798`,
      cpu: 2,
      memoryMb: 4096,
      volumeGb: 10,
      compute: null, // not checked yet
      computeRef: { projectId: 'p1', environmentId: 'e1', services: { worca: { serviceId: 's1', deploymentId: 'd1' }, broker: { serviceId: 's2', deploymentId: null } } },
      edgeRef: { tunnelId: 't1', dnsRecordIds: ['r1', 'r2'] },
    });
    const list = await json<{ instances: { id: string; name: string }[] }>(call('GET', `/api/platform/instances?orgId=${orgId}`, as(support)));
    expect(list.instances).toEqual([expect.objectContaining({ id, name: 'Prod box' })]);
  });

  it('shows the outbound network policy read-only (D73): effective, inherited or not, pending; the org detail its policy', async () => {
    setInstancesDeps({ getKeyRing: () => fakes.ring });
    try {
      const orgId = await seedOrg(fakes, await seedUser(fakes), 'Egress Org');
      const ctx = (table: string, column: string, rowId: string) => ({ table, column, rowId, owner: { type: 'org' as const, id: orgId } });
      await insertRow('org_egress_policies', {
        org_id: orgId, mode: 'block', version: 2, updated_at: Date.now(),
        hosts: await fakes.ring.encrypt(ctx('org_egress_policies', 'hosts', orgId), JSON.stringify({ allow: [], deny: ['pastebin.com'] })),
      });
      const follows = await seedNamedInstance(orgId, 'Follows', { egress_pending: 1 });
      const ownId = crypto.randomUUID();
      await seedNamedInstance(orgId, 'Own', { id: ownId, egress_mode: 'allow', egress_hosts: await fakes.ring.encrypt(ctx('instances', 'egress_hosts', ownId), JSON.stringify({ allow: ['a.com'], deny: [] })) });
      expect((await json<Record<string, unknown>>(call('GET', `/api/platform/instances/${follows}`, as(support)))).egress).toEqual({
        effective: { mode: 'block', allow: [], deny: ['pastebin.com'] }, inherited: true, pending: true,
      });
      expect((await json<Record<string, unknown>>(call('GET', `/api/platform/instances/${ownId}`, as(support)))).egress).toEqual({
        effective: { mode: 'allow', allow: ['a.com'], deny: [] }, inherited: false, pending: false,
      });
      expect((await json<Record<string, unknown>>(call('GET', `/api/platform/orgs/${orgId}`, as(support)))).egress).toEqual({ mode: 'block', allow: [], deny: ['pastebin.com'] });
    } finally {
      setInstancesDeps();
    }
  });

  it('shows the compute facts Railway last reported, beside the tier size', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes), 'Facts Org');
    const services = {
      worca: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 791 },
      broker: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 872 },
      cloudflared: { cpu: 2, memoryMb: 4000, volumeMb: null, volumeUsedMb: null },
    };
    const id = await seedNamedInstance(orgId, 'US box', {
      cpu: 2, memory_mb: 4096, volume_gb: 10, compute_facts: JSON.stringify({ region: 'sfo', services }), compute_facts_at: 1_700_000_000_000,
    });
    const detail = await json<Record<string, unknown>>(call('GET', `/api/platform/instances/${id}`, as(support)));
    expect(detail).toMatchObject({
      cpu: 2, memoryMb: 4096, volumeGb: 10,
      compute: { region: 'sfo', regionLabel: 'US West (California)', eu: false, services, checkedAt: 1_700_000_000_000 },
    });
    expect(detail).not.toHaveProperty('compute_facts');
    expect(detail).not.toHaveProperty('region');
  });

  it('carries the stop reason and the latest operation with its step and last error', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes), 'Op Org');
    const id = await seedNamedInstance(orgId, 'Op box', { status: 'stopped', stopped_reason: 'Mining pool traffic' });
    const before = await json<Record<string, unknown>>(call('GET', `/api/platform/instances/${id}`, as(support)));
    expect(before).toMatchObject({ stoppedReason: 'Mining pool traffic', stoppedForAbuse: 1, op: null });
    const now = Date.now();
    const row = { instance_id: id, org_id: orgId, workflow_id: null, step_running: 0, outcome: null, finished_at: null };
    await insertRow('instance_ops', { ...row, op_id: 'op-old', kind: 'create', phase: 'ready', phase_started_at: now - 9e5, step: null, attempts: 0, started_at: now - 1e6, updated_at: now - 9e5, status: 'done', last_error: null });
    await insertRow('instance_ops', { ...row, op_id: 'op-new', kind: 'lift', workflow_id: 'wf-1', phase: 'waiting', phase_started_at: now - 60_000, step: 'heartbeat: check', attempts: 2, started_at: now - 120_000, updated_at: now, status: 'running', last_error: 'no heartbeat yet' });
    const after = await json<{ op: Record<string, unknown> }>(call('GET', `/api/platform/instances/${id}`, as(support)));
    expect(after.op).toMatchObject({
      opId: 'op-new', kind: 'lift', phase: 'waiting', phases: ['starting', 'waiting', 'ready'], step: 'heartbeat: check', attempts: 2,
      lastError: 'no heartbeat yet', status: 'running', workflowId: 'wf-1', stuck: false,
    });
  });
});

describe('overview stats (P1, P3)', () => {
  type Stats = {
    orgs: { total: number; createdLast7Days: number };
    users: { total: number; active: number; pending: number };
    instances: { byStatus: Record<string, number>; silent: number; degraded: number; stuckCreating: number; byVersion: Record<string, number> };
    waitlist: number;
    openRegistrationCodes: number;
    thresholds: { silentAfterMs: number };
  };

  it('counts orgs, users, instance states, versions, waitlist and open codes', async () => {
    const before = await json<Stats>(call('GET', '/api/platform/stats', as(support)));
    expect(before.thresholds.silentAfterMs).toBe(5 * 60_000); // markStale's threshold

    const orgId = await seedOrg(fakes, await seedUser(fakes));
    const old = await seedOrg(fakes, await seedUser(fakes));
    await testEnv.DB.prepare('UPDATE org_settings SET created_at = ? WHERE org_id = ?').bind(Date.now() - 30 * 86_400_000, old).run();
    await seedUser(fakes, { status: 'pending' });
    const now = Date.now();
    await seedNamedInstance(orgId, 'a', { worca_version: '9.1.0' }); // healthy
    await seedNamedInstance(orgId, 'b', { worca_version: '9.1.0', last_heartbeat_at: now - 20 * 60_000, health: 'degraded' }); // silent + degraded
    await seedNamedInstance(orgId, 'c', { status: 'creating', worca_version: null, created_at: now - 30 * 60_000 }); // stuck
    await seedNamedInstance(orgId, 'd', { status: 'creating', worca_version: null }); // just started
    await testEnv.DB.prepare('INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), 'free', 1, null, now)
      .run();
    await testEnv.DB.prepare('INSERT INTO registration_codes (code_hash, created_by, tier, uses_left, expires_at, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), 'free', 1, now - 1000, now) // expired
      .run();

    const after = await json<Stats>(call('GET', '/api/platform/stats', as(support)));
    expect(after.orgs.total - before.orgs.total).toBe(2);
    expect(after.orgs.createdLast7Days - before.orgs.createdLast7Days).toBe(1);
    expect(after.users.pending - before.users.pending).toBe(1);
    expect(after.users.active - before.users.active).toBe(2); // the two org founders
    expect(after.waitlist - before.waitlist).toBe(1);
    expect((after.instances.byStatus.running ?? 0) - (before.instances.byStatus.running ?? 0)).toBe(2);
    expect((after.instances.byStatus.creating ?? 0) - (before.instances.byStatus.creating ?? 0)).toBe(2);
    expect(after.instances.silent - before.instances.silent).toBe(1);
    expect(after.instances.degraded - before.instances.degraded).toBe(1);
    expect(after.instances.stuckCreating - before.instances.stuckCreating).toBe(1);
    expect(after.instances.byVersion['9.1.0']).toBe(2);
    expect(after.openRegistrationCodes - before.openRegistrationCodes).toBe(1);
  });

  it('needs a platform role', async () => {
    expect((await call('GET', '/api/platform/stats', as(await seedUser(fakes)))).status).toBe(403);
  });
});

describe('registration codes (P7)', () => {
  it('stores a note encrypted and lists it with the total uses', async () => {
    const created = await json<{ id: string; usesTotal: number; note: string }>(
      call('POST', '/api/platform/registration/codes', { ...as(admin), body: { uses: 4, note: 'For Jane at Beta Labs' } }),
    );
    expect(created).toMatchObject({ usesTotal: 4, note: 'For Jane at Beta Labs' });
    const row = await testEnv.DB.prepare('SELECT note, uses_total, uses_left FROM registration_codes WHERE code_hash = ?').bind(created.id).first<{ note: string; uses_total: number; uses_left: number }>();
    expect(row).toMatchObject({ uses_total: 4, uses_left: 4 });
    expect(row?.note).not.toContain('Jane');
    expect(fakes.ring.isCiphertext(row?.note)).toBe(true);

    await testEnv.DB.prepare('UPDATE registration_codes SET uses_left = 3 WHERE code_hash = ?').bind(created.id).run();
    const list = await json<{ codes: { id: string; note: string | null; usesLeft: number; usesTotal: number }[] }>(call('GET', '/api/platform/registration/codes', as(admin)));
    expect(list.codes.find((c) => c.id === created.id)).toMatchObject({ note: 'For Jane at Beta Labs', usesLeft: 3, usesTotal: 4 });

    const audit = await testEnv.DB.prepare("SELECT details FROM audit_platform WHERE action = 'platform.code_created' AND target_id = ?").bind(created.id.slice(0, 16)).first<{ details: string }>();
    expect(audit?.details).not.toContain('Jane');
  });

  it('a code without a note, and a note too long', async () => {
    const created = await json<{ id: string; note: string | null }>(call('POST', '/api/platform/registration/codes', { ...as(admin), body: {} }));
    expect(created.note).toBeNull();
    expect((await call('POST', '/api/platform/registration/codes', { ...as(admin), body: { note: 'x'.repeat(201) } })).status).toBe(400);
  });
});

describe('waitlist approval', () => {
  it('records registeredVia approved, so the account may create an org', async () => {
    const u = await seedUser(fakes, { status: 'pending' });
    await testEnv.DB.prepare("UPDATE user SET registeredVia = 'waitlist' WHERE id = ?").bind(u.id).run();
    expect((await call('POST', `/api/platform/waitlist/${u.id}/approve`, as(admin))).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT status, registeredVia FROM user WHERE id = ?').bind(u.id).first()).toEqual({ status: 'active', registeredVia: 'approved' });
    expect(fakes.mail.at(-1)?.to).toBe(u.email);
    expect((await call('POST', `/api/platform/waitlist/${u.id}/approve`, as(admin))).status).toBe(404);
    expect((await call('POST', `/api/platform/waitlist/${crypto.randomUUID()}/approve`, as(admin))).status).toBe(404);
  });
});

describe('releases (P10, D77)', () => {
  let reg: ReturnType<typeof fakeRegistry>;
  // An image for `v` whose label says `v` (200), none (404), or GHCR failing (503).
  const tags = { set: (v: string, status: number) => reg.images.set(v, status === 200 ? {} : { status }) };

  beforeEach(() => {
    reg = fakeRegistry();
    setTenancyDeps({ fetch: reg.fetch });
  });
  afterEach(async () => {
    await testEnv.DB.prepare("DELETE FROM platform_settings WHERE key IN ('worca_version', 'release_auto_enroll', 'auto_update_soak_hours')").run();
    await testEnv.DB.prepare('DELETE FROM worca_releases').run();
    await testEnv.DB.prepare('DELETE FROM release_holds').run();
  });

  it('checks the image on GHCR, records the release and lists it with instance counts', async () => {
    tags.set('2.0.0', 200);
    const res = await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.0.0' } });
    expect(res.status).toBe(200);
    expect(reg.requests.map((r) => [r.method, r.url])).toEqual([
      ['GET', 'https://ghcr.io/token?scope=repository:sinishadjukic/worca:pull&service=ghcr.io'],
      ['GET', 'https://ghcr.io/v2/sinishadjukic/worca/manifests/2.0.0'],
      ['GET', 'https://ghcr.io/v2/sinishadjukic/worca/manifests/sha256:idx-2.0.0'],
      ['GET', 'https://ghcr.io/v2/sinishadjukic/worca/blobs/sha256:cfg-2.0.0'],
    ]);
    expect(reg.requests[1]?.headers.get('authorization')).toBe('Bearer anon-token');
    expect(reg.requests[1]?.headers.get('accept')).toContain('application/vnd.oci.image.index.v1+json');

    const orgId = await seedOrg(fakes, await seedUser(fakes));
    await seedInstance(orgId); // 1.8.0, older than the hosted minimum
    await seedNamedInstance(orgId, 'x', { worca_version: '2.0.0' });

    const { latest, releases, held, settings } = await json<{
      latest: string;
      releases: { version: string; publishedAt: number | null; publishedBy: string | null; source: string | null; instances: number; latest: boolean }[];
      held: unknown[];
      settings: unknown;
    }>(call('GET', '/api/platform/releases', as(support)));
    expect(latest).toBe('2.0.0');
    expect(releases.map((r) => r.version)).toEqual([...releases.map((r) => r.version)].sort().reverse()); // newest first
    expect(releases.find((r) => r.version === '2.0.0')).toMatchObject({ publishedAt: expect.any(Number), publishedBy: root.id, source: 'manual', instances: 1, latest: true, withdrawn: null });
    // The previous latest (the built-in default) stays recorded and deployable.
    expect(releases.find((r) => r.version === '1.9.0')).toMatchObject({ publishedAt: null, latest: false });
    // The seeded 1.8.0 instance is listed, but 1.8.0 can't run hosted.
    expect(releases.find((r) => r.version === '1.8.0')).toMatchObject({ deployable: false, source: null });
    expect(releases.find((r) => r.version === '2.0.0')).toMatchObject({ deployable: true });
    expect(held).toEqual([]);
    expect(settings).toEqual({ autoEnroll: true, soakHours: 0 });
    expect(await isPublishedVersion(testEnv, '1.9.0', null)).toBe(true);

    tags.set('2.1.0', 200);
    expect((await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.1.0' } })).status).toBe(200);
    expect(await isPublishedVersion(testEnv, '2.0.0', null)).toBe(true);
    expect(await isPublishedVersion(testEnv, '2.0.1', null)).toBe(false);
    const audit = await testEnv.DB.prepare("SELECT details FROM audit_platform WHERE action = 'platform.worca_version_set' ORDER BY at DESC LIMIT 1").first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toMatchObject({ version: '2.1.0' });
  });

  it('offers the latest to older instances and clears the offer on instances already on it', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    const older = await seedNamedInstance(orgId, 'older', { worca_version: '1.8.0' });
    const current = await seedNamedInstance(orgId, 'current', { worca_version: '2.0.0', available_version: '2.5.0' });
    tags.set('2.0.0', 200);
    const res = await json<{ instancesNotified: number }>(call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.0.0' } }));
    expect(res.instancesNotified).toBeGreaterThanOrEqual(1);
    const avail = async (id: string) => (await testEnv.DB.prepare('SELECT available_version AS v FROM instances WHERE id = ?').bind(id).first<{ v: string | null }>())?.v;
    expect(await avail(older)).toBe('2.0.0');
    expect(await avail(current)).toBeNull();
  });

  it('refuses a tag that is not on GHCR (422), one that reports another version (422) and a registry outage (502)', async () => {
    expect((await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '3.0.0' } })).status).toBe(422);
    reg.images.set('3.0.0', { label: '3.0.0-rc.4' });
    const mismatch = await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '3.0.0' } });
    expect(mismatch.status).toBe(422);
    expect(await json(mismatch)).toEqual({ error: 'image_version_mismatch', reports: '3.0.0-rc.4' });
    tags.set('3.0.0', 503);
    expect((await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '3.0.0' } })).status).toBe(502);
    expect(await testEnv.DB.prepare("SELECT 1 FROM worca_releases WHERE version = '3.0.0'").first()).toBeNull();
    expect(await json<{ version: string }>(call('GET', '/api/platform/worca-version', as(support)))).toEqual({ version: '1.9.0' });
  });

  it('refuses a version older than the hosted minimum (422) and never deploys one', async () => {
    tags.set('1.8.0', 200);
    const res = await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '1.8.0' } });
    expect(res.status).toBe(422);
    expect(await json<{ error: string }>(res)).toEqual({ error: 'version_unsupported' });
    expect(await testEnv.DB.prepare("SELECT 1 FROM worca_releases WHERE version = '1.8.0' AND published_at IS NOT NULL").first()).toBeNull();
    // Recorded once as a release or not: an image older than 1.9.0 can't verify identity tokens.
    await testEnv.DB.prepare("INSERT OR IGNORE INTO worca_releases (version, published_at, published_by) VALUES ('1.8.0', NULL, NULL)").run();
    expect(await isPublishedVersion(testEnv, '1.8.0', '1.8.0')).toBe(false);
  });

  it('withdraws and restores a release; a withdrawn one is listed and can only be restored', async () => {
    tags.set('2.0.0', 200);
    tags.set('2.1.0', 200);
    await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.0.0' } });
    await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.1.0' } });

    expect((await call('POST', '/api/platform/releases/2.1.0/withdraw', { ...as(root), body: { reason: '' } })).status).toBe(400);
    const w = await call('POST', '/api/platform/releases/2.1.0/withdraw', { ...as(root), body: { reason: 'CVE-2026-0001 in the broker' } });
    expect(w.status).toBe(200);
    expect(await json(w)).toMatchObject({ ok: true, latest: '2.0.0' });
    const { latest, releases } = await json<{ latest: string; releases: { version: string; deployable: boolean; withdrawn: unknown }[] }>(call('GET', '/api/platform/releases', as(support)));
    expect(latest).toBe('2.0.0');
    expect(releases.find((r) => r.version === '2.1.0')).toMatchObject({ deployable: false, withdrawn: { at: expect.any(Number), by: root.id, reason: 'CVE-2026-0001 in the broker' } });
    expect((await call('POST', '/api/platform/releases/2.1.0/withdraw', { ...as(root), body: { reason: 'again' } })).status).toBe(409);
    // Publishing it by hand is refused: restore it.
    const again = await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.1.0' } });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: 'release_withdrawn' });

    expect(await json(await call('POST', '/api/platform/releases/2.1.0/restore', as(root)))).toEqual({ ok: true, latest: '2.1.0' });
    expect((await call('POST', '/api/platform/releases/2.1.0/restore', as(root))).status).toBe(409);
    expect((await call('POST', '/api/platform/releases/9.9.9/withdraw', { ...as(root), body: { reason: 'x' } })).status).toBe(404);
    expect((await call('POST', '/api/platform/releases/latest/withdraw', { ...as(root), body: { reason: 'x' } })).status).toBe(404);
    const actions = (await testEnv.DB.prepare("SELECT action FROM audit_platform WHERE action LIKE 'platform.release_%' ORDER BY at").all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.release_withdrawn', 'platform.release_restored']));
  });

  it('lists npm versions held back from enrollment', async () => {
    await testEnv.DB.prepare("INSERT INTO release_holds (version, reason, detail, first_seen_at, checked_at) VALUES ('2.2.0', 'label_mismatch', '2.2.0-rc.1', 1, 2)").run();
    const { held } = await json<{ held: unknown[] }>(call('GET', '/api/platform/releases', as(support)));
    expect(held).toEqual([{ version: '2.2.0', reason: 'label_mismatch', reports: '2.2.0-rc.1', firstSeenAt: 1, checkedAt: 2 }]);
  });

  it('changes the release settings', async () => {
    const res = await call('PUT', '/api/platform/release-settings', { ...as(root), body: { autoEnroll: false, soakHours: 72 } });
    expect(res.status).toBe(200);
    expect((await json<{ settings: unknown }>(call('GET', '/api/platform/releases', as(support)))).settings).toEqual({ autoEnroll: false, soakHours: 72 });
    expect((await call('PUT', '/api/platform/release-settings', { ...as(root), body: { autoEnroll: true, soakHours: 721 } })).status).toBe(400);
  });

  it('D80: lists candidates as rc, deployable only until their release is out, and withdraws them', async () => {
    await testEnv.DB.prepare("INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_version', '2.0.0', 0)").run();
    const rec = (v: string) => testEnv.DB.prepare("INSERT INTO worca_releases (version, published_at, published_by, source) VALUES (?, 1, NULL, 'npm')").bind(v).run();
    for (const v of ['2.0.0', '2.0.0-rc.1', '2.1.0-rc.1', '2.1.0-rc.2']) await rec(v);
    const list = async () => (await json<{ releases: { version: string; rc: boolean; deployable: boolean; latest: boolean }[] }>(call('GET', '/api/platform/releases', as(support)))).releases;
    expect((await list()).filter((r) => r.version.startsWith('2.')).map(({ version, rc, deployable, latest }) => ({ version, rc, deployable, latest }))).toEqual([
      { version: '2.1.0-rc.2', rc: true, deployable: true, latest: false },
      { version: '2.1.0-rc.1', rc: true, deployable: true, latest: false },
      { version: '2.0.0', rc: false, deployable: true, latest: true },
      { version: '2.0.0-rc.1', rc: true, deployable: false, latest: false },
    ]);
    expect((await call('POST', '/api/platform/releases/2.1.0-rc.1/withdraw', { ...as(root), body: { reason: 'Broken clone' } })).status).toBe(200);
    expect((await list()).find((r) => r.version === '2.1.0-rc.1')).toMatchObject({ deployable: false, withdrawn: { reason: 'Broken clone' } });
    // A candidate is never published as the latest by hand.
    expect((await call('PUT', '/api/platform/worca-version', { ...as(root), body: { version: '2.1.0-rc.2' } })).status).toBe(400);
  });

  it('D80: release candidates are switched per org by staff with tenant rights, and audited', async () => {
    const orgId = await seedOrg(fakes, await seedUser(fakes));
    const path = `/api/platform/orgs/${orgId}/release-candidates`;
    expect((await json<{ releaseCandidates: boolean }>(call('GET', `/api/platform/orgs/${orgId}`, as(support)))).releaseCandidates).toBe(false);
    expect((await call('PUT', path, { ...as(support), body: { enabled: true } })).status).toBe(403);
    expect(await json(call('PUT', path, { ...as(root), body: { enabled: true } }))).toEqual({ ok: true, enabled: true, changed: true });
    expect(await json(call('PUT', path, { ...as(root), body: { enabled: true } }))).toEqual({ ok: true, enabled: true, changed: false });
    expect((await json<{ releaseCandidates: boolean }>(call('GET', `/api/platform/orgs/${orgId}`, as(support)))).releaseCandidates).toBe(true);
    const audit = await testEnv.DB.prepare("SELECT details FROM audit_platform WHERE action = 'org.release_candidates_set' AND target_id = ?").bind(orgId).all<{ details: string }>();
    expect(audit.results.map((r) => JSON.parse(r.details))).toEqual([{ enabled: true }]);
    expect((await call('PUT', `/api/platform/orgs/${crypto.randomUUID()}/release-candidates`, { ...as(root), body: { enabled: true } })).status).toBe(404);
    expect((await call('PUT', path, { ...as(root), body: { enabled: 'yes' } })).status).toBe(400);
  });

  it('publishing, withdrawing and the settings stay superadmin-only', async () => {
    tags.set('2.0.0', 200);
    expect((await call('PUT', '/api/platform/worca-version', { ...as(admin), body: { version: '2.0.0' } })).status).toBe(403);
    expect((await call('POST', '/api/platform/releases/1.9.0/withdraw', { ...as(admin), body: { reason: 'x' } })).status).toBe(403);
    expect((await call('POST', '/api/platform/releases/1.9.0/restore', as(admin))).status).toBe(403);
    expect((await call('PUT', '/api/platform/release-settings', { ...as(admin), body: { autoEnroll: false, soakHours: 1 } })).status).toBe(403);
    expect(reg.requests).toEqual([]);
  });
});

describe('staff and roles (P11)', () => {
  it('lists each binding with the person’s name and address', async () => {
    const { bindings } = await json<{ bindings: { userId: string; role: string; name: string | null; email: string | null }[] }>(call('GET', '/api/platform/roles', as(root)));
    expect(bindings).toEqual(expect.arrayContaining([expect.objectContaining({ userId: root.id, role: 'superadmin', name: 'Root Person', email: root.email })]));
    expect(bindings.find((b) => b.userId === support.id)).toMatchObject({ role: 'support', email: support.email });
    expect((await call('GET', '/api/platform/roles', as(admin))).status).toBe(403);
  });
});

describe('key counts (P12)', () => {
  type Keys = {
    wrapped: Record<'org' | 'user', { version: number; masterId: string | null; count: number }[]>;
    destroyed: Record<'org' | 'user', number>;
    master: { masterId: string; total: number; done: number; status: string } | null;
    lastOrgKeyRotationAt: number | null;
  };
  const count = (k: Keys, type: 'org' | 'user', version: number, masterId: string | null) =>
    k.wrapped[type].find((w) => w.version === version && w.masterId === masterId)?.count ?? 0;

  it('counts live keys by owner, version and master key; destroyed keys apart', async () => {
    const before = await json<Keys>(call('GET', '/api/platform/keys', as(root)));
    expect(before.master?.masterId).toEqual(expect.any(String));
    const add = (type: string, owner: string, version: number, wrapped: string | null, masterId: string | null, at = Date.now()) =>
      testEnv.DB.prepare('INSERT INTO data_keys (id, owner_type, owner_id, version, wrapped, created_at, destroyed_at, master_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), type, owner, version, wrapped, at, wrapped ? null : at, masterId)
        .run();
    const org = crypto.randomUUID();
    await add('org', org, 1, 'm1.aaa.bbb', 'kold');
    await add('org', org, 2, 'm1.ccc.ddd', 'kold', 1_234_567);
    await add('user', crypto.randomUUID(), 1, 'm1.eee.fff', null);
    await add('user', crypto.randomUUID(), 1, null, null);
    const after = await json<Keys>(call('GET', '/api/platform/keys', as(root)));
    expect(count(after, 'org', 1, 'kold') - count(before, 'org', 1, 'kold')).toBe(1);
    expect(count(after, 'org', 2, 'kold') - count(before, 'org', 2, 'kold')).toBe(1);
    expect(count(after, 'user', 1, null) - count(before, 'user', 1, null)).toBe(1);
    expect(after.destroyed.user - before.destroyed.user).toBe(1);
    expect(after.lastOrgKeyRotationAt).toBeGreaterThanOrEqual(1_234_567);
    expect(after.master).toMatchObject({ total: (before.master?.total ?? 0) + 3, status: 'pending' });
    expect(JSON.stringify(after)).not.toContain('m1.');
  });

  it('master key fingerprints only for keys.master; other staff get counts by version', async () => {
    const org = crypto.randomUUID();
    for (const [version, masterId] of [[1, 'kfpA'], [1, 'kfpB'], [7, 'kfpA']] as const) {
      await testEnv.DB.prepare('INSERT INTO data_keys (id, owner_type, owner_id, version, wrapped, created_at, master_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), 'org', `${org}-${version}-${masterId}`, version, 'm1.x.y', Date.now(), masterId)
        .run();
    }
    const full = await json<Keys>(call('GET', '/api/platform/keys', as(root)));
    expect(full.master?.masterId).toEqual(expect.any(String));
    expect(count(full, 'org', 1, 'kfpA')).toBe(1);
    for (const who of [support, admin]) {
      const res = await call('GET', '/api/platform/keys', as(who));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('kfp');
      expect(text).not.toContain(full.master!.masterId);
      const body = JSON.parse(text) as Keys & { wrapped: Record<'org' | 'user', Record<string, unknown>[]> };
      expect('master' in body).toBe(false);
      expect(body.wrapped.org.every((g) => !('masterId' in g))).toBe(true);
      // Versions are merged across master keys: one group per version.
      const versions = body.wrapped.org.map((g) => g.version);
      expect(new Set(versions).size).toBe(versions.length);
      const sum = (k: { wrapped: Record<'org' | 'user', { version: number; count: number }[]> }, v: number) =>
        k.wrapped.org.filter((g) => g.version === v).reduce((a, g) => a + g.count, 0);
      expect(sum(body, 7)).toBe(sum(full, 7));
      expect(sum(body, 1)).toBe(sum(full, 1));
    }
  });
});

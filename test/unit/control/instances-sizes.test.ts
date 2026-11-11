// Compute sizes (D78): a tier lists the sizes its orgs may pick; a new instance gets the tier's
// default or a picked one; a tenant admin moves an instance to another size, applied like remote
// access (reconfigure: the worca service's limits and parallelism, then a worca restart).
import { beforeEach, describe, expect, it } from 'vitest';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import { orgSummary } from '../../../packages/platform/src/control/instances/summary';
import { getProviders } from '../../../packages/platform/src/control/providers';
import { E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const setSize = (orgId: string, id: string, user: string, body: unknown) => app.call('POST', `/api/orgs/${orgId}/instances/${id}/size`, { user, body });
const create = (orgId: string, user: string, body: Record<string, unknown>) => app.call('POST', `/api/orgs/${orgId}/instances`, { user, body });

function opsCtx(stub: ReturnType<typeof fakeStubFetch>): OpsContext & { steps: ReturnType<typeof immediateSteps> } {
  return { env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(), pollMs: 1, maxPolls: 3 };
}

async function onTier(orgId: string, tier: string) {
  await E.DB.prepare(`INSERT OR REPLACE INTO org_settings (org_id, tier, status, created_at) VALUES (?, ?, 'active', ?)`).bind(orgId, tier, Date.now()).run();
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('creating an instance', () => {
  it('gets the tier default (standard on free); a size the tier does not allow is refused', async () => {
    const o = await seedOrg();
    const refused = await create(o.orgId, o.admin, { name: 'Main', teamId: o.teamA, size: 'large' });
    expect(refused).toMatchObject({ status: 400, json: { error: 'size_not_allowed' } });
    expect((await create(o.orgId, o.admin, { name: 'Main', teamId: o.teamA, size: 'huge' })).status).toBe(400);
    const made = await create(o.orgId, o.admin, { name: 'Main', teamId: o.teamA });
    expect(made.status).toBe(201);
    expect(made.json.size).toEqual({ id: 'standard', name: 'Standard', vcpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2, pending: false });
    expect(await instanceRow(made.json.id)).toMatchObject({ compute_size: 'standard', cpu: 2, memory_mb: 4096, size_pending: 0 });
  });

  it('on Team: up to 5 instances, Large can be picked', async () => {
    const o = await seedOrg();
    await onTier(o.orgId, 'team');
    const made = await create(o.orgId, o.admin, { name: 'Big', teamId: o.teamA, size: 'large' });
    expect(made.status).toBe(201);
    expect(await instanceRow(made.json.id)).toMatchObject({ compute_size: 'large', cpu: 4, memory_mb: 8192 });
    expect((await create(o.orgId, o.admin, { name: 'XL', teamId: o.teamA, size: 'xl' })).json).toEqual({ error: 'size_not_allowed' });
    for (let n = 2; n <= 5; n++) expect((await create(o.orgId, o.admin, { name: `I${n}`, teamId: o.teamA })).status).toBe(201);
    expect(await create(o.orgId, o.admin, { name: 'Sixth', teamId: o.teamA })).toMatchObject({ status: 403, json: { error: 'tier_limit' } });
  });

  it('the summary offers the tier\'s sizes and default', async () => {
    const o = await seedOrg();
    await onTier(o.orgId, 'business');
    const s = await orgSummary(E, o.orgId);
    expect(s.instances.limit).toBe(10);
    expect(s.instances.sizes.map((x) => x.id)).toEqual(['standard', 'large', 'xl']);
    expect(s.instances.defaultSize).toBe('standard');
  });
});

describe('POST /api/orgs/:orgId/instances/:id/size', () => {
  it('running: stored with its ceiling, pending, reconfigure started, audited', async () => {
    const o = await seedOrg();
    await onTier(o.orgId, 'business');
    const i = await seedInstance(o.orgId);
    const res = await setSize(o.orgId, i.id, o.admin, { size: 'xl' });
    expect(res).toMatchObject({ status: 200, json: { ok: true, result: 'applying', size: { id: 'xl', vcpu: 8, memoryMb: 16384 } } });
    expect(await instanceRow(i.id)).toMatchObject({ compute_size: 'xl', cpu: 8, memory_mb: 16384, size_pending: 1, pending_op: 'reconfigure' });
    expect(recorded.ops).toEqual([{ op: 'reconfigure', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toEqual([
      expect.objectContaining({ action: 'instance.size_set', targetId: i.id, details: { from: 'standard', to: 'xl' } }),
    ]);
  });

  it('suspended: only stored, for the next start', async () => {
    const o = await seedOrg();
    await onTier(o.orgId, 'team');
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    expect((await setSize(o.orgId, i.id, o.admin, { size: 'large' })).json).toMatchObject({ result: 'saved' });
    expect(await instanceRow(i.id)).toMatchObject({ compute_size: 'large', size_pending: 1, pending_op: null });
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg[0]).toMatchObject({ details: { from: 'standard', to: 'large', appliesOnStart: true } });
  });

  it('only sizes the tier allows; an instance above its tier keeps its size and can move down', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { compute_size: 'xl', cpu: 8, memory_mb: 16384 }); // org on free now
    expect((await setSize(o.orgId, i.id, o.admin, { size: 'large' })).json).toEqual({ error: 'size_not_allowed' });
    expect((await setSize(o.orgId, i.id, o.admin, { size: 'xl' })).json).toMatchObject({ result: 'unchanged' });
    expect((await setSize(o.orgId, i.id, o.admin, { size: 'standard' })).json).toMatchObject({ result: 'applying' });
    expect(await instanceRow(i.id)).toMatchObject({ compute_size: 'standard', cpu: 2, memory_mb: 4096 });
  });

  it('tenant users are refused; busy instances answer 409', async () => {
    const o = await seedOrg();
    await onTier(o.orgId, 'team');
    const i = await seedInstance(o.orgId);
    expect((await setSize(o.orgId, i.id, o.user, { size: 'large' })).status).toBe(403);
    const busy = await seedInstance(o.orgId, { pending_op: 'rotate' });
    expect(await setSize(o.orgId, busy.id, o.admin, { size: 'large' })).toMatchObject({ status: 409, json: { error: 'instance_busy' } });
    expect((await setSize(o.orgId, i.id, o.admin, { size: 'large', extra: 1 })).status).toBe(400);
  });
});

describe('applying a size', () => {
  it('reconfigure sends the size to the worca service, restarts worca and clears pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { compute_size: 'large', cpu: 4, memory_mb: 8192, size_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect(stub.calls[0]!.body.variables.size).toEqual({ cpu: 4, memoryMb: 8192, maxParallel: 6, maxParallelScripts: 3 });
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, size_pending: 0 });
  });

  it('a wake applies a size saved while asleep', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', compute_size: 'large', cpu: 4, memory_mb: 8192, size_pending: 1 });
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub);
    await runOp(ctx, { op: 'wake', instanceId: i.id });
    expect(ctx.steps.names).toContain('set worca settings');
    expect(stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables.size).toMatchObject({ cpu: 4, maxParallel: 6 });
  });
});

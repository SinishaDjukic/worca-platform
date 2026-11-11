// Compute facts (src/control/instances/compute-facts.ts): read from the provider after create and
// upgrade and by the 5-minute cron, stored on the instance row, shown by the tenant API.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { RAILWAY_INFO } from '../../../packages/platform/src/control/providers/railway';
import {
  computeView,
  FACTS_MAX_AGE_MS,
  FACTS_PER_TICK,
  isEuRegion,
  refreshComputeFacts,
  refreshDueComputeFacts,
  regionLabel,
} from '../../../packages/platform/src/control/instances/compute-facts';
import { CRON_STALE, runCrons } from '../../../packages/platform/src/control/instances/crons';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import type { ComputeFacts, ComputeRef } from '../../../packages/platform/src/control/providers/types';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });

const US_FACTS: ComputeFacts = {
  region: 'sfo',
  services: {
    worca: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 791 },
    broker: { cpu: 2, memoryMb: 4000, volumeMb: 50000, volumeUsedMb: 872 },
    cloudflared: { cpu: 2, memoryMb: 4000, volumeMb: null, volumeUsedMb: null },
  },
};

/** The fake providers with describe() replaced. */
function providersWith(describe: (ref: ComputeRef) => Promise<ComputeFacts>, stub = fakeStubFetch()): Providers & { described: string[] } {
  const base = getProviders(E, stub.fetchImpl);
  const described: string[] = [];
  return {
    ...base,
    described,
    compute: { ...base.compute, describe: async (ref) => (described.push(ref.projectId), describe(ref)) },
  };
}

function ctxWith(providers: Providers, onSleep?: (name: string) => Promise<void>, maxPolls = 3): OpsContext & { steps: ReturnType<typeof immediateSteps> } {
  return { env: E, providers, steps: immediateSteps(onSleep), pollMs: 1, maxPolls };
}

const storedFacts = async (id: string) => {
  const row = await instanceRow(id);
  return { facts: row?.compute_facts ? JSON.parse(row.compute_facts) : null, at: row?.compute_facts_at ?? null };
};

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('region labels', () => {
  it('names Railway regions and tells the EU apart', () => {
    expect(regionLabel(RAILWAY_INFO, 'sfo')).toBe('US West (California)');
    expect(regionLabel(RAILWAY_INFO, 'us-west2')).toBe('US West (California)');
    expect(regionLabel(RAILWAY_INFO, 'europe-west4-drams3a')).toBe('EU West (Amsterdam)');
    expect(regionLabel(RAILWAY_INFO, 'us-east4-eqdc4a')).toBe('US East (Virginia)');
    expect(regionLabel(RAILWAY_INFO, 'asia-southeast1-eqsg3a')).toBe('Southeast Asia (Singapore)');
    expect(regionLabel(RAILWAY_INFO, 'mars-1')).toBe('mars-1');
    expect(regionLabel(RAILWAY_INFO, null)).toBeNull();
    expect(isEuRegion(RAILWAY_INFO, 'europe-west4-drams3a')).toBe(true);
    expect(isEuRegion(RAILWAY_INFO, 'sfo')).toBe(false);
  });

  it('computeView: null until checked, then region, label, EU flag, services and checkedAt', () => {
    expect(computeView(RAILWAY_INFO, { compute_facts: null, compute_facts_at: null })).toBeNull();
    expect(computeView(RAILWAY_INFO, { compute_facts: 'garbage', compute_facts_at: 1 })).toBeNull();
    expect(computeView(RAILWAY_INFO, { compute_facts: JSON.stringify(US_FACTS), compute_facts_at: 123 })).toEqual({
      region: 'sfo', regionLabel: 'US West (California)', eu: false, services: US_FACTS.services, checkedAt: 123,
    });
    expect(computeView(RAILWAY_INFO, { compute_facts: JSON.stringify({ ...US_FACTS, region: null }), compute_facts_at: 1 })).toMatchObject({ region: null, regionLabel: null, eu: null });
  });
});

describe('create and upgrade store the facts', () => {
  it('create reads the facts after the first heartbeat', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const id = created.json.id as string;
    expect(created.json.compute).toBeNull();
    const stub = fakeStubFetch();
    const providers = providersWith(async () => US_FACTS, stub);
    const ctx = ctxWith(providers, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });
    expect(await runOp(ctx, { op: 'create', instanceId: id })).toEqual({ ok: true, outcome: 'running' });
    expect(ctx.steps.names.slice(-2)).toEqual(['notify created', 'compute facts']);
    expect((await storedFacts(id)).facts).toEqual(US_FACTS);

    // The tenant API shows them.
    const view = await app.call('GET', `/api/orgs/${o.orgId}/instances/${id}`, { user: o.admin });
    expect(view.json.compute).toMatchObject({ region: 'sfo', regionLabel: 'US West (California)', eu: false, services: US_FACTS.services });
    expect(view.json.compute.checkedAt).toEqual(expect.any(Number));
  });

  it('the fake provider reports the EU and the per-service ceilings', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect(await refreshComputeFacts(E, getProviders(E, fakeStubFetch().fetchImpl), i.id)).toBe(true);
    const { facts } = await storedFacts(i.id);
    expect(facts.region).toBe('europe-west4-drams3a');
    expect(facts.services.cloudflared.volumeMb).toBeNull();
  });

  it('a failing read never fails the create, and keeps the facts from before', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const id = created.json.id as string;
    await E.DB.prepare(`UPDATE instances SET compute_facts = ?, compute_facts_at = 5 WHERE id = ?`).bind(JSON.stringify(US_FACTS), id).run();
    const stub = fakeStubFetch();
    const providers = providersWith(async () => {
      throw new Error('railway computeFacts: HTTP 500');
    }, stub);
    const ctx = ctxWith(providers, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });
    expect(await runOp(ctx, { op: 'create', instanceId: id })).toEqual({ ok: true, outcome: 'running' });
    expect(providers.described).toEqual([id]);
    expect(await storedFacts(id)).toEqual({ facts: US_FACTS, at: 5 });
  });

  it('upgrade reads the facts again once the new version reports', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0' });
    const providers = providersWith(async () => US_FACTS);
    const ctx = ctxWith(providers, async () => void (await sendBeat(i.credential, beat({ version: '1.9.0' }))));
    expect(await runOp(ctx, { op: 'upgrade', instanceId: i.id, version: '1.9.0' })).toEqual({ ok: true, outcome: 'upgraded' });
    expect(ctx.steps.names.at(-1)).toBe('compute facts');
    expect((await storedFacts(i.id)).facts).toEqual(US_FACTS);
    await E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'worca_released_versions'`).run();
  });

  it('no facts for an instance without a compute ref or one being deleted', async () => {
    const o = await seedOrg();
    const providers = providersWith(async () => US_FACTS);
    const noRef = await seedInstance(o.orgId, { compute_ref: null });
    const deleting = await seedInstance(o.orgId, { status: 'deleting' });
    expect(await refreshComputeFacts(E, providers, noRef.id)).toBe(false);
    expect(await refreshComputeFacts(E, providers, deleting.id)).toBe(false);
    expect(providers.described).toEqual([]);
  });
});

describe('periodic refresh', () => {
  /** Marks every existing row as freshly checked, so only this test's rows are due. */
  const settleOthers = (now: number) => E.DB.prepare(`UPDATE instances SET compute_facts_at = ?`).bind(now).run();

  it('fills instances never checked and renews stale ones; leaves fresh, creating and deleting ones', async () => {
    const now = Date.now();
    await settleOthers(now);
    const o = await seedOrg();
    const never = await seedInstance(o.orgId);
    const stale = await seedInstance(o.orgId, { status: 'suspended', compute_facts: '{}', compute_facts_at: now - FACTS_MAX_AGE_MS - 1 });
    const fresh = await seedInstance(o.orgId, { compute_facts: '{}', compute_facts_at: now - 60_000 });
    const creating = await seedInstance(o.orgId, { status: 'creating' });
    const deleting = await seedInstance(o.orgId, { status: 'deleting' });
    const providers = providersWith(async () => US_FACTS);
    expect(await refreshDueComputeFacts(E, providers, now)).toBe(2);
    expect(providers.described.sort()).toEqual([never.id, stale.id].sort());
    expect(await storedFacts(never.id)).toEqual({ facts: US_FACTS, at: now });
    expect(await storedFacts(stale.id)).toEqual({ facts: US_FACTS, at: now });
    for (const i of [fresh, creating, deleting]) expect(providers.described).not.toContain(i.id);
  });

  it('reads at most FACTS_PER_TICK instances per tick, and a failure keeps the old facts', async () => {
    const now = Date.now();
    await settleOthers(now);
    const o = await seedOrg();
    const ids: string[] = [];
    for (let k = 0; k < FACTS_PER_TICK + 2; k++) ids.push((await seedInstance(o.orgId, { compute_facts: '{"region":"sfo"}', compute_facts_at: 1 })).id);
    const providers = providersWith(async () => {
      throw new Error('railway: rate limited');
    });
    expect(await refreshDueComputeFacts(E, providers, now)).toBe(0);
    expect(providers.described).toHaveLength(FACTS_PER_TICK);
    for (const id of ids) expect(await storedFacts(id)).toEqual({ facts: { region: 'sfo' }, at: 1 });
  });

  it('the 5-minute cron runs the pass (fake provider)', async () => {
    const scheduledTime = Date.UTC(2032, 0, 1, 0, 5);
    await settleOthers(scheduledTime);
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime }), E, createExecutionContext());
    const { facts, at } = await storedFacts(i.id);
    expect(at).toBe(scheduledTime);
    expect(facts.region).toBe('europe-west4-drams3a');
  });
});

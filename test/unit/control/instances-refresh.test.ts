// D76: component refresh. The images each deploy records, the same-version upgrade that redeploys
// only an out-of-date cloudflared, the refresh op, the wake that starts from the new image, and the
// cron that refreshes running instances.
import { beforeEach, describe, expect, it } from 'vitest';
import { autoRefresh, AUTO_REFRESH_PER_TICK, REFRESH_RETRY_MS } from '../../../packages/platform/src/control/instances/auto-update';
import { DEFAULT_CLOUDFLARED_IMAGE as CLOUDFLARED_IMAGE, imageSources, imagesFor, needsRefresh, outdatedServices } from '../../../packages/platform/src/control/instances/images';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import type { ComputeRef, InstanceSpec } from '../../../packages/platform/src/control/providers/types';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const SRC = imageSources(E);
const OLD = 'cloudflare/cloudflared:2026.9.1';
const NEW_TAG = CLOUDFLARED_IMAGE.slice(CLOUDFLARED_IMAGE.lastIndexOf(':') + 1);
const deployed = (version: string, cloudflared = CLOUDFLARED_IMAGE) => JSON.stringify({ ...imagesFor(version, SRC), cloudflared });

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

/** Fake providers that record deploy and start calls and answer the connector versions given. */
function providersWith(versions: () => string[] | null = () => null) {
  const stub = fakeStubFetch();
  const base = getProviders(E, stub.fetchImpl);
  const deploys: { image: InstanceSpec['image']; kinds?: readonly string[] }[] = [];
  const starts: (Parameters<Providers['compute']['start']>[1] | undefined)[] = [];
  const providers: Providers = {
    ...base,
    compute: {
      ...base.compute,
      async deploy(ref: ComputeRef, image: InstanceSpec['image'], kinds?: readonly (keyof ComputeRef['services'])[]) {
        deploys.push({ image, ...(kinds ? { kinds } : {}) });
        return base.compute.deploy(ref, image, kinds);
      },
      async start(ref, opts) {
        starts.push(opts);
        return base.compute.start(ref, opts);
      },
    },
    edge: { ...base.edge, connectorVersions: async () => versions() },
  };
  return { providers, deploys, starts, stub };
}

const ctx = (providers: Providers, steps = immediateSteps(), maxPolls = 3): OpsContext => ({ env: E, providers, steps, pollMs: 1, maxPolls });

describe('image sources', () => {
  it('default to the public worca image and the pinned cloudflared; a deployment can set both', () => {
    expect(imageSources({})).toEqual({ worca: 'ghcr.io/sinishadjukic/worca', cloudflared: CLOUDFLARED_IMAGE });
    const own = imageSources({ WORCA_IMAGE: 'registry.example.com/acme/worca', CLOUDFLARED_IMAGE: 'mirror.example.com/cloudflared:2026.11.0' });
    expect(imagesFor('1.9.1', own)).toEqual({
      worca: 'registry.example.com/acme/worca:1.9.1',
      broker: 'registry.example.com/acme/worca:1.9.1',
      cloudflared: 'mirror.example.com/cloudflared:2026.11.0',
    });
    // Another cloudflared pin makes running instances out of date, as a new default pin does.
    expect(outdatedServices({ worca_version: '1.9.1', deployed_images: deployed('1.9.1') }, own)).toEqual(['worca', 'broker', 'cloudflared']);
  });
});

describe('outdated services (D76)', () => {
  it('only cloudflared, and unknown counts as out of date; worca and the broker follow the version', () => {
    expect(outdatedServices({ worca_version: '1.9.1', deployed_images: null }, SRC)).toEqual(['cloudflared']);
    expect(outdatedServices({ worca_version: '1.9.1', deployed_images: deployed('1.9.1', OLD) }, SRC)).toEqual(['cloudflared']);
    expect(outdatedServices({ worca_version: '1.9.1', deployed_images: deployed('1.9.1') }, SRC)).toEqual([]);
    expect(outdatedServices({ worca_version: null, deployed_images: null }, SRC)).toEqual([]);
    // A recorded worca image of another version (an upgrade not yet confirmed) is beyond a refresh.
    expect(needsRefresh({ worca_version: '1.9.1', deployed_images: deployed('1.9.2', OLD) }, SRC)).toBe(false);
    expect(needsRefresh({ worca_version: '1.9.1', deployed_images: 'not json' }, SRC)).toBe(true);
  });
});

describe('same-version upgrade route (D76)', () => {
  it('starts a refresh when cloudflared is out of date, refuses when nothing is, and lists the current version as a refresh', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0', OLD) });
    const versions = await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}/versions`, { user: o.admin });
    expect(versions.json.versions.find((v: { current: boolean }) => v.current)).toMatchObject({ version: '1.9.0', direction: 'refresh' });
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin })).json).toMatchObject({ componentsOutdated: true });

    const path = `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`;
    expect(await app.call('POST', path, { user: o.admin, body: { version: '1.9.0' } })).toEqual({
      status: 202, json: { ok: true, status: 'running', refreshing: true, version: '1.9.0' },
    });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: 'refresh', target_version: null });
    expect(recorded.ops).toEqual([{ op: 'refresh', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toMatchObject([{ action: 'instance.refresh_started', actorScope: 'tenant', targetId: i.id }]);
    // Under way: refused like any other busy instance.
    expect(await app.call('POST', path, { user: o.admin, body: { version: '1.9.0' } })).toEqual({ status: 409, json: { error: 'instance_not_running' } });

    const fresh = await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0') });
    expect(await app.call('POST', `/api/orgs/${o.orgId}/instances/${fresh.id}/upgrade`, { user: o.admin, body: { version: '1.9.0' } })).toEqual({
      status: 409, json: { error: 'already_on_version' },
    });
  });
});

describe('refresh op (D76)', () => {
  it('redeploys only cloudflared, waits for the new connector, then records the images and audits without mail', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0', OLD), pending_op: 'refresh' });
    let polls = 0;
    const { providers, deploys, stub } = providersWith(() => (++polls === 1 ? ['2026.9.1', NEW_TAG] : [NEW_TAG, NEW_TAG]));
    const steps = immediateSteps();
    expect(await runOp(ctx(providers, steps), { op: 'refresh', instanceId: i.id, actorId: 'admin-1' })).toEqual({ ok: true, outcome: 'refreshed' });

    expect(deploys).toEqual([{ image: imagesFor('1.9.0', SRC), kinds: ['cloudflared'] }]);
    expect(stub.calls).toEqual([]); // worca (the stub) was never touched
    expect(steps.names).toEqual(['load', 'deploy components', 'new connector: check', 'new connector: wait', 'new connector: check', 'finish']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: null, deployed_images: JSON.stringify(imagesFor('1.9.0', SRC)) });
    expect(recorded.auditOrg).toMatchObject([
      { action: 'instance.components_refreshed', actorId: 'admin-1', details: { from: { cloudflared: OLD }, to: { cloudflared: CLOUDFLARED_IMAGE } } },
    ]);
    expect(recorded.mails).toEqual([]);
  });

  it('the old connector still serving in time: fails, releases the claim and leaves the images out of date', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0', OLD), pending_op: 'refresh' });
    const { providers } = providersWith(() => ['2026.9.1']);
    await expect(runOp(ctx(providers), { op: 'refresh', instanceId: i.id })).rejects.toThrow(/did not report cloudflared/);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, deployed_images: deployed('1.9.0', OLD) });
  });

  it('nothing connected yet is not a confirmation', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', pending_op: 'refresh' });
    const { providers } = providersWith(() => []);
    await expect(runOp(ctx(providers), { op: 'refresh', instanceId: i.id })).rejects.toThrow(/did not report cloudflared/);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, deployed_images: null });
  });

  it('already up to date (refreshed meanwhile): records and finishes without deploying', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0'), pending_op: 'refresh' });
    const { providers, deploys } = providersWith();
    expect(await runOp(ctx(providers), { op: 'refresh', instanceId: i.id })).toEqual({ ok: true, outcome: 'refreshed' });
    expect(deploys).toEqual([]);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null });
  });
});

describe('images recorded by other operations (D76)', () => {
  it('an upgrade records the new version’s images', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.8.0', status: 'upgrading', target_version: '1.9.0' });
    const { providers } = providersWith();
    const steps = immediateSteps(async () => void (await app.call('POST', '/api/heartbeat', { body: beat({ version: '1.9.0' }), headers: { authorization: `Bearer ${i.credential}` } })));
    expect(await runOp(ctx(providers, steps), { op: 'upgrade', instanceId: i.id, version: '1.9.0' })).toEqual({ ok: true, outcome: 'upgraded' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', deployed_images: JSON.stringify(imagesFor('1.9.0', SRC)) });
  });

  it('a wake starts an out-of-date cloudflared from the new image and records it once the connector reports in', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', status: 'suspended', pending_op: 'wake', deployed_images: deployed('1.9.0', OLD) });
    const { providers, starts } = providersWith(() => [NEW_TAG]);
    const steps = immediateSteps(async () => void (await app.call('POST', '/api/heartbeat', { body: beat({ version: '1.9.0' }), headers: { authorization: `Bearer ${i.credential}` } })));
    expect(await runOp(ctx(providers, steps), { op: 'wake', instanceId: i.id })).toMatchObject({ ok: true });
    expect(starts).toEqual([{ images: { cloudflared: CLOUDFLARED_IMAGE } }]);
    expect(steps.names.slice(-2)).toEqual(['new connector: check', 'record images']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', deployed_images: JSON.stringify(imagesFor('1.9.0', SRC)) });
  });

  it('a wake whose connector doesn’t confirm still succeeds and leaves the images for the cron', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', status: 'suspended', pending_op: 'wake', deployed_images: deployed('1.9.0', OLD) });
    const { providers } = providersWith(() => ['2026.9.1']);
    const steps = immediateSteps(async () => void (await app.call('POST', '/api/heartbeat', { body: beat({ version: '1.9.0' }), headers: { authorization: `Bearer ${i.credential}` } })));
    expect(await runOp(ctx(providers, steps), { op: 'wake', instanceId: i.id })).toMatchObject({ ok: true });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', deployed_images: deployed('1.9.0', OLD) });
  });

  it('a wake with nothing out of date starts as before', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.0', status: 'suspended', pending_op: 'wake', deployed_images: deployed('1.9.0') });
    const { providers, starts } = providersWith();
    const steps = immediateSteps(async () => void (await app.call('POST', '/api/heartbeat', { body: beat({ version: '1.9.0' }), headers: { authorization: `Bearer ${i.credential}` } })));
    await runOp(ctx(providers, steps), { op: 'wake', instanceId: i.id });
    expect(starts).toEqual([undefined]);
    expect(steps.names).not.toContain('new connector: check');
  });
});

describe('automatic refresh (D76)', () => {
  it('starts refreshes of running out-of-date instances, a few per tick, skipping busy, sleeping and recently failed ones', async () => {
    await E.DB.prepare(`DELETE FROM instances`).run();
    const o = await seedOrg();
    const now = Date.now();
    const stale = [];
    for (let n = 0; n < AUTO_REFRESH_PER_TICK + 1; n++) stale.push(await seedInstance(o.orgId, { worca_version: '1.9.0', updated_at: n + 10 }));
    await seedInstance(o.orgId, { worca_version: '1.9.0', deployed_images: deployed('1.9.0'), updated_at: 1 });
    await seedInstance(o.orgId, { worca_version: '1.9.0', status: 'suspended', updated_at: 2 });
    await seedInstance(o.orgId, { worca_version: '1.9.0', pending_op: 'reconfigure', updated_at: 3 });
    const failed = await seedInstance(o.orgId, { worca_version: '1.9.0', updated_at: 4 });
    await E.DB.prepare(
      `INSERT INTO instance_ops (op_id, instance_id, org_id, kind, phase, phase_started_at, started_at, updated_at, status) VALUES ('f1', ?, ?, 'refresh', 'waiting', ?, ?, ?, 'failed')`,
    )
      .bind(failed.id, o.orgId, now - 1000, now - 1000, now - 1000)
      .run();

    const started = await autoRefresh(E, now);
    expect(started).toEqual(stale.slice(0, AUTO_REFRESH_PER_TICK).map((i) => i.id));
    expect(recorded.ops.map((p) => [p.op, p.instanceId, p.automatic, p.actorId])).toEqual(started.map((id) => ['refresh', id, true, null]));
    expect(recorded.auditOrg[0]).toMatchObject({ action: 'instance.refresh_started', actorScope: 'system', details: { automatic: true } });

    // The failed one is tried again once its retry delay is over.
    expect(await autoRefresh(E, now + REFRESH_RETRY_MS + 1)).toEqual([failed.id, stale.at(-1)!.id]);
  });
});

import { introspectWorkflowInstance } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteInstanceNow, getInstance } from '../../../packages/platform/src/control/instances/api';
import { runOp, type OpsContext, type StepRunner } from '../../../packages/platform/src/control/instances/ops';
import { confirmDeleteHandler } from '../../../packages/platform/src/control/instances/routes';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });

function opsCtx(stub: ReturnType<typeof fakeStubFetch>, onSleep?: (name: string) => Promise<void>, maxPolls = 3): OpsContext & { steps: ReturnType<typeof immediateSteps> } {
  return { env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(onSleep), pollMs: 1, maxPolls };
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('create', () => {
  it('provisions through the fake providers and goes running on the first heartbeat', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const id = created.json.id as string;
    const stub = fakeStubFetch();
    // The instance "boots" while the Workflow waits: post a beat with the credential it was given.
    const ctx = opsCtx(stub, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });

    expect(await runOp(ctx, { op: 'create', instanceId: id })).toEqual({ ok: true, outcome: 'running' });

    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /__admin/instances',
      `POST /__admin/instances/${id}/variables`,
      `POST /__admin/instances/${id}/deploy`,
    ]);
    const host = created.json.host as string;
    const keyHost = created.json.keyHost as string;
    expect(stub.calls[0]!.body).toEqual({ instanceId: id, host, keyHost });
    const vars = stub.calls[1]!.body.variables;
    expect(vars).toMatchObject({ allowedHosts: host, identityAudience: host, keyPageAudience: keyHost, identityIssuer: E.APP_ORIGIN });
    expect(vars.heartbeatUrl).toMatch(/\/api\/heartbeat$/);
    expect(stub.calls[2]!.body.image).toBe('ghcr.io/sinishadjukic/worca:1.9.0');

    const row = (await getInstance(E, id))!;
    expect(row).toMatchObject({ status: 'running', worca_version: '1.9.0', last_error: null });
    expect(JSON.parse(row.edge_ref!)).toEqual({ tunnelId: `fake-tunnel-${id}`, dnsRecordIds: [`fake-dns-${host}`, `fake-dns-${keyHost}`] });
    expect(JSON.parse(row.compute_ref!).projectId).toBe(id);

    expect(await gateFake().hosts()).toEqual({
      [host]: { instanceId: id, kind: 'worca', upstream: 'http://127.0.0.1:9100' },
      [keyHost]: { instanceId: id, kind: 'keypage', upstream: 'http://127.0.0.1:9100' },
    });
    expect((await gateFake().calls()).filter((c) => c[0] === 'setStatus')).toEqual([
      ['setStatus', id, 'creating'], // the Workflow registers the hosts before the first beat
      ['setStatus', id, 'running'], // the beat
    ]);
    expect(recorded.mails).toMatchObject([{ to: `${o.admin}@example.com`, subject: 'Your Worca instance Main is ready' }]);
  });

  it('records no_heartbeat and notifies when the instance never reports', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'creating', compute_ref: null, edge_ref: null });
    const ctx = opsCtx(fakeStubFetch(), undefined, 2);
    expect(await runOp(ctx, { op: 'create', instanceId: i.id })).toEqual({ ok: false, outcome: 'no_heartbeat' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'creating', last_error: 'no_heartbeat' });
    // The gate already knows the hosts and shows them as still being created.
    expect(Object.keys(await gateFake().hosts())).toHaveLength(2);
    expect(recorded.mails[0]?.subject).toMatch(/could not be started/);
  });

  it('stops when the instance was deleted meanwhile', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'deleting' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'create', instanceId: i.id })).toEqual({ ok: false, outcome: 'aborted' });
    expect(stub.calls).toEqual([]);
  });
});

describe('suspend and wake (D48)', () => {
  it('suspend stops the services and sets suspended in D1 and the gate', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'suspend' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'suspend', instanceId: i.id })).toEqual({ ok: true, outcome: 'suspended' });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /__admin/instances/${i.id}/stop`]);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'suspended', pending_op: null });
    expect(await gateFake().calls()).toEqual([['setStatus', i.id, 'suspended']]);
  });

  it('wake starts the services; the first beat sets running', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential))), { op: 'wake', instanceId: i.id });
    expect(r).toEqual({ ok: true, outcome: 'running' });
    expect(stub.calls.map((c) => c.path)).toEqual([`/__admin/instances/${i.id}/start`]);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: null });
  });

  it('a wake that never sees a beat gives up so a later visit can retry', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    expect((await runOp(opsCtx(fakeStubFetch(), undefined, 2), { op: 'wake', instanceId: i.id })).outcome).toBe('wake_timeout');
    expect(await instanceRow(i.id)).toMatchObject({ status: 'suspended', pending_op: null, last_error: 'wake_timeout' });
  });
});

describe('upgrade', () => {
  it('a move to an older published version is worded as moving back', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0","1.9.2"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.2', target_version: '1.9.0' });
    recorded.mails.length = 0;
    const r = await runOp(opsCtx(fakeStubFetch(), async () => void (await sendBeat(i.credential, beat({ version: '1.9.0' })))), {
      op: 'upgrade', instanceId: i.id, version: '1.9.0',
    });
    expect(r).toEqual({ ok: true, outcome: 'upgraded' });
    expect(recorded.mails.map((m) => m.subject + ' ' + m.text).join('\n')).toMatch(/moved back to 1\.9\.0/);
    await E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'worca_released_versions'`).run();
  });

  it('deploys the new images and completes when the new version reports', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0' });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential, beat({ version: '1.9.0' })))), {
      op: 'upgrade', instanceId: i.id, version: '1.9.0',
    });
    expect(r).toEqual({ ok: true, outcome: 'upgraded' });
    expect(stub.calls.map((c) => c.body?.image)).toEqual(['ghcr.io/sinishadjukic/worca:1.9.0']);
    // D68: an upgrade only changes the image; the broker's secret and vault key stay as they are.
    expect(stub.calls.some((c) => c.path.endsWith('/variables'))).toBe(false);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', worca_version: '1.9.0' });
    await E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'worca_released_versions'`).run();
  });

  it('rolls back to the previous image when the new version never reports', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.0', available_version: '1.10.0', target_version: '1.10.0' });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential, beat({ version: '1.9.0' }))), 2), {
      op: 'upgrade', instanceId: i.id, version: '1.10.0',
    });
    expect(r).toEqual({ ok: false, outcome: 'rolled_back' });
    expect(stub.calls.map((c) => c.body?.image)).toEqual(['ghcr.io/sinishadjukic/worca:1.10.0', 'ghcr.io/sinishadjukic/worca:1.9.0']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', last_error: 'upgrade_timeout', target_version: null });
    expect(recorded.mails[0]?.subject).toMatch(/rolled back to 1\.9\.0/);
  });

  it('refuses an unpublished version inside the op, before any image is chosen', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', target_version: '6.6.6' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'upgrade', instanceId: i.id, version: '6.6.6' })).toEqual({ ok: false, outcome: 'aborted' });
    expect(stub.calls).toEqual([]);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', last_error: 'unknown_version' });
  });
});

describe('stop', () => {
  it('sets the gate status first, then stops the services', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'stop', instanceId: i.id })).toEqual({ ok: true, outcome: 'stopped' });
    expect(await gateFake().calls()).toEqual([['setStatus', i.id, 'stopped']]);
    expect(stub.calls.map((c) => c.path)).toEqual([`/__admin/instances/${i.id}/stop`]);
  });
});

describe('delete (D29, D60)', () => {
  it('the confirmation handler starts deletion, also while stopped; the op removes everything', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped' });
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamA).run();
    await sendBeat(i.credential); // ignored (stopped), but proves nothing lingers afterwards

    const waitUntil = () => undefined;
    await expect(confirmDeleteHandler(E, { waitUntil }, { userId: o.user, orgId: o.orgId, target: i.id, payload: {} })).rejects.toThrow('forbidden');
    await confirmDeleteHandler(E, { waitUntil }, { userId: o.admin, orgId: o.orgId, target: i.id, payload: {} });
    expect((await instanceRow(i.id))?.status).toBe('deleting');
    expect(recorded.ops).toEqual([{ op: 'delete', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toMatchObject([{ action: 'instance.delete_started', actorId: o.admin }]);

    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'delete', instanceId: i.id })).toEqual({ ok: true, outcome: 'deleted' });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /__admin/instances/${i.id}`]);
    const host = `${i.slug}.${E.INSTANCE_DOMAIN}`;
    const keyHost = `${i.keySlug}.${E.INSTANCE_DOMAIN}`;
    expect(await gateFake().calls()).toEqual([
      ['setStatus', i.id, 'deleting'], // deleteInstanceNow
      ['setStatus', i.id, 'deleting'], // op step 1
      ['deleteHost', host],
      ['deleteHost', keyHost],
      ['destroy', i.id],
    ]);
    expect(await instanceRow(i.id)).toBeNull();
    expect(await E.DB.prepare(`SELECT 1 FROM instance_teams WHERE instance_id = ?`).bind(i.id).first()).toBeNull();
    expect((await sendBeat(i.credential)).status).toBe(401); // credential gone with the row
    expect(recorded.auditPlatform).toMatchObject([{ action: 'instance.deleted', targetId: i.id }]);
    // Running it again is harmless.
    expect(await runOp(opsCtx(stub), { op: 'delete', instanceId: i.id })).toEqual({ ok: true, outcome: 'already_gone' });
  });
});

describe('broker secrets (D68)', () => {
  it('create gives worca and the broker one fresh shared secret and a vault key, kept out of D1 and step results', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const id = created.json.id as string;
    const stub = fakeStubFetch();
    const results: unknown[] = [];
    const inner = immediateSteps(async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential);
    });
    const steps: StepRunner = {
      async do(name, fn, opts) {
        const r = await inner.do(name, fn, opts);
        results.push(r);
        return r;
      },
      sleep: (n, ms) => inner.sleep(n, ms),
    };
    expect(await runOp({ ...opsCtx(stub), steps }, { op: 'create', instanceId: id })).toEqual({ ok: true, outcome: 'running' });

    const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
    expect(vars.brokerSecret.length).toBeGreaterThanOrEqual(32);
    expect(atob(vars.brokerVaultKey)).toHaveLength(32);
    expect(vars.instanceUrl).toBe(`${E.INSTANCE_SCHEME}://${created.json.host}${E.INSTANCE_ORIGIN_SUFFIX}`);
    expect(vars.keyPageUrl).toBe(`${E.INSTANCE_SCHEME}://${created.json.keyHost}${E.INSTANCE_ORIGIN_SUFFIX}`);
    const row = JSON.stringify(await instanceRow(id));
    for (const secret of [vars.brokerSecret, vars.brokerVaultKey, vars.heartbeatCredential]) {
      expect(row).not.toContain(secret);
      expect(JSON.stringify(results)).not.toContain(secret);
    }

    // Another instance gets its own.
    const o2 = await seedOrg();
    const c2 = await app.call('POST', `/api/orgs/${o2.orgId}/instances`, { user: o2.admin, body: { name: 'Two', teamId: o2.teamA } });
    const stub2 = fakeStubFetch();
    await runOp(opsCtx(stub2, undefined, 1), { op: 'create', instanceId: c2.json.id });
    const vars2 = stub2.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
    expect(vars2.brokerSecret).not.toBe(vars.brokerSecret);
    expect(vars2.brokerVaultKey).not.toBe(vars.brokerVaultKey);
  });
});

describe('delete during create', () => {
  type Hooks = Partial<Record<string, () => Promise<void>>>;
  /** Providers that record every call by name and run hooks[name] right after the real call. */
  function racing(stub: ReturnType<typeof fakeStubFetch>, hooks: Hooks) {
    const base = getProviders(E, stub.fetchImpl);
    const calls: string[] = [];
    const wrap = <T extends object>(obj: T): T =>
      new Proxy(obj, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (typeof v !== 'function') return v;
          return async (...args: unknown[]) => {
            // A spec or a compute ref is named by its instance or project id.
            const a = args[0] as { instanceId?: string; projectId?: string } | unknown;
            const label = a && typeof a === 'object' && !Array.isArray(a) ? ((a as { instanceId?: string }).instanceId ?? (a as { projectId?: string }).projectId) : a;
            calls.push(`${String(prop)} ${JSON.stringify(label)}`);
            const r = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            await hooks[String(prop)]?.();
            return r;
          };
        },
      });
    const providers: Providers = { compute: wrap(base.compute), edge: wrap(base.edge) };
    return { providers, calls };
  }

  /** The tenant's confirmed delete, run to its end while the create is mid-step. */
  const deleteNow = (id: string) => async () => {
    await deleteInstanceNow(E, id, { actorId: null });
    expect(await runOp(opsCtx(fakeStubFetch()), { op: 'delete', instanceId: id })).toEqual({ ok: true, outcome: 'deleted' });
  };

  async function creating() {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    return created.json as { id: string; host: string; keyHost: string };
  }

  it('confirmed while the Railway project is being created: the create removes the project itself', async () => {
    const inst = await creating();
    const stub = fakeStubFetch();
    const r = racing(stub, { createProject: deleteNow(inst.id) });
    expect(await runOp({ ...opsCtx(stub), providers: r.providers }, { op: 'create', instanceId: inst.id })).toEqual({ ok: false, outcome: 'aborted' });
    // The delete ran before any ref was saved, so only the create's undo can find the project.
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /__admin/instances', `DELETE /__admin/instances/${inst.id}`]);
    expect(r.calls).toEqual([`createProject "${inst.id}"`, `destroy "${inst.id}"`]);
    expect(await instanceRow(inst.id)).toBeNull();
    expect(await gateFake().hosts()).toEqual({});
  });

  it('confirmed while DNS records are being added: tunnel, records and project are all removed', async () => {
    const inst = await creating();
    const stub = fakeStubFetch();
    const r = racing(stub, { addDns: deleteNow(inst.id) });
    expect(await runOp({ ...opsCtx(stub), providers: r.providers }, { op: 'create', instanceId: inst.id })).toEqual({ ok: false, outcome: 'aborted' });
    const dns = [`fake-dns-${inst.host}`, `fake-dns-${inst.keyHost}`];
    // The delete saw the project and the tunnel (saved by earlier steps); the records only the undo knows.
    expect(r.calls).toEqual([
      `createProject "${inst.id}"`,
      `createTunnel "${inst.id}"`,
      `addDns "${inst.id}"`,
      `destroy "${inst.id}"`,
      `deleteDns ${JSON.stringify(dns)}`,
      `deleteTunnel "fake-tunnel-${inst.id}"`,
    ]);
    expect(stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1); // the undo's destroy; the delete's ran on its own stub
    expect(await gateFake().hosts()).toEqual({});
  });

  it('confirmed just before the gate learns the hosts: the hosts and the gate object are removed again', async () => {
    const inst = await creating();
    const stub = fakeStubFetch();
    const inner = immediateSteps();
    const steps: StepRunner = {
      async do(name, fn, opts) {
        if (name === 'gate hosts') await deleteNow(inst.id)();
        return inner.do(name, fn, opts);
      },
      sleep: (n, ms) => inner.sleep(n, ms),
    };
    expect(await runOp({ ...opsCtx(stub), steps }, { op: 'create', instanceId: inst.id })).toEqual({ ok: false, outcome: 'aborted' });
    expect(await gateFake().hosts()).toEqual({});
    const gateCalls = (await gateFake().calls()).map((c) => c.join(' '));
    expect(gateCalls.slice(-3)).toEqual([`deleteHost ${inst.host}`, `deleteHost ${inst.keyHost}`, `destroy ${inst.id}`]);
    expect(inner.names).not.toContain('set variables');
  });

  it('a create that failed half-way saved no refs: the delete finds the project, tunnel and records anyway', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'deleting', compute_ref: null, edge_ref: null });
    const stub = fakeStubFetch(); // the stub knows the instance: found "by name"
    const base = getProviders(E, stub.fetchImpl);
    const removed: string[] = [];
    const providers: Providers = {
      compute: base.compute,
      edge: {
        ...base.edge,
        findEdge: async (id, hosts) => {
          expect(id).toBe(i.id);
          expect(hosts).toEqual([`${i.slug}.${E.INSTANCE_DOMAIN}`, `${i.keySlug}.${E.INSTANCE_DOMAIN}`]);
          return { tunnelId: 'tun-left', dnsRecordIds: ['rec-left'] };
        },
        deleteDns: async (ids) => void removed.push(...ids),
        deleteTunnel: async (t) => void removed.push(t),
      },
    };
    expect(await runOp({ ...opsCtx(stub), providers }, { op: 'delete', instanceId: i.id })).toEqual({ ok: true, outcome: 'deleted' });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /__admin/instances/${i.id}`, `DELETE /__admin/instances/${i.id}`]);
    expect(removed).toEqual(['rec-left', 'tun-left']);
  });

  it('a create that is not overtaken runs through its checks unchanged', async () => {
    const inst = await creating();
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub, undefined, 1);
    expect(await runOp(ctx, { op: 'create', instanceId: inst.id })).toEqual({ ok: false, outcome: 'no_heartbeat' });
    expect(ctx.steps.names.filter((n) => n.endsWith('overtaken?'))).toEqual([
      'create project: overtaken?', 'create tunnel: overtaken?', 'add dns: overtaken?', 'gate hosts: overtaken?',
    ]);
    expect(ctx.steps.names).not.toContain('undo create');
  });
});

describe('InstanceOpsWorkflow', () => {
  // The Workflow builds its own providers, so the fake compute calls the stub instance server's
  // admin API. No stub runs during unit tests: answer it here, or the lookup fails, the step
  // retries and the test hangs.
  beforeEach(() => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === '127.0.0.1:9100' && url.pathname.startsWith('/__admin/')) return new Response('not found', { status: 404 });
      return real(input, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs an op through Workflow steps', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'deleting', compute_ref: null, edge_ref: null });
    const wfId = `delete-${i.id}`;
    const instance = await introspectWorkflowInstance(E.INSTANCE_OPS, wfId);
    try {
      await E.INSTANCE_OPS.create({ id: wfId, params: { op: 'delete', instanceId: i.id } });
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toEqual({ ok: true, outcome: 'deleted' });
    } finally {
      await instance.dispose();
    }
    expect(await instanceRow(i.id)).toBeNull();
    expect((await gateFake().calls()).map((c) => c[0])).toEqual(['setStatus', 'deleteHost', 'deleteHost', 'destroy']);
  });
});

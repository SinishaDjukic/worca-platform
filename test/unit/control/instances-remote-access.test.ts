// Remote access in worca (D72): tenant admins turn the terminal and actions on or off per instance;
// the reconfigure op sets WORCA_TERMINAL_REMOTE / WORCA_ACTIONS_REMOTE on the worca service only
// and restarts worca; suspended and stopped instances get them on their next start.
import { beforeEach, describe, expect, it } from 'vitest';
import { changeRemoteAccess, getInstance, stopForAbuse, type InstanceRow } from '../../../packages/platform/src/control/instances/api';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import { createRailwayProvider } from '../../../packages/platform/src/control/providers/railway';
import type { Env } from '../../../packages/platform/src/control/env';
import type { ComputeRef } from '../../../packages/platform/src/control/providers/types';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });
const setRemote = (orgId: string, id: string, user: string, body: unknown, mfa = true) =>
  app.call('POST', `/api/orgs/${orgId}/instances/${id}/remote-access`, { user, body, headers: mfa ? {} : { 'x-test-mfa': '0' } });

function opsCtx(stub: ReturnType<typeof fakeStubFetch>, onSleep?: (name: string) => Promise<void>, maxPolls = 3): OpsContext & { steps: ReturnType<typeof immediateSteps> } {
  return { env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(onSleep), pollMs: 1, maxPolls };
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('POST /api/orgs/:orgId/instances/:id/remote-access', () => {
  it('a tenant admin turns the terminal on: stored, pending, audited, reconfigure started', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const res = await setRemote(o.orgId, i.id, o.admin, { terminal: true, actions: false });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, result: 'applying', remoteAccess: { terminal: true, actions: false } });
    expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 1, actions_remote: 0, remote_pending: 1, pending_op: 'reconfigure' });
    expect(recorded.ops).toEqual([{ op: 'reconfigure', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toEqual([
      {
        orgId: o.orgId, actorId: o.admin, actorScope: 'tenant', action: 'instance.remote_access_set', targetType: 'instance', targetId: i.id,
        details: { from: { terminal: false, actions: false }, to: { terminal: true, actions: false } },
      },
    ]);
    const view = await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin });
    expect(view.json.remoteAccess).toEqual({ terminal: true, actions: false, pending: true });
  });

  it('tenant users, outsiders and platform staff are refused; nothing changes', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect((await setRemote(o.orgId, i.id, o.user, { terminal: true, actions: true })).status).toBe(403);
    expect((await setRemote(o.orgId, i.id, o.outsider, { terminal: true, actions: true })).status).toBe(403);
    // Platform roles grant nothing on tenant routes (D15): not a member, so 404.
    const staff = crypto.randomUUID();
    const now = Date.now();
    await E.DB.batch([
      E.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, status) VALUES (?, ?, ?, 1, ?, ?, 'active')`).bind(staff, staff, `${staff}@staff.test`, now, now),
      E.DB.prepare(`INSERT INTO platform_roles (user_id, role, granted_at) VALUES (?, 'superadmin', ?)`).bind(staff, now),
    ]);
    expect((await setRemote(o.orgId, i.id, staff, { terminal: true, actions: true })).status).toBe(404);
    expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 0, actions_remote: 0, remote_pending: 0, pending_op: null });
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg).toEqual([]);
  });

  it('turning one on needs an MFA session; turning both off does not', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const refused = await setRemote(o.orgId, i.id, o.admin, { terminal: false, actions: true }, false);
    expect(refused).toMatchObject({ status: 403, json: { error: 'mfa_required' } });
    expect(await instanceRow(i.id)).toMatchObject({ actions_remote: 0, pending_op: null });

    const on = await seedInstance(o.orgId, { status: 'suspended', terminal_remote: 1, actions_remote: 1 });
    const off = await setRemote(o.orgId, on.id, o.admin, { terminal: false, actions: false }, false);
    expect(off).toMatchObject({ status: 200, json: { result: 'saved' } });
    expect(await instanceRow(on.id)).toMatchObject({ terminal_remote: 0, actions_remote: 0, remote_pending: 1 });
  });

  it('validates the body', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    for (const body of [{}, { terminal: true }, { terminal: 'yes', actions: false }, { terminal: true, actions: false, shell: true }, null]) {
      expect((await setRemote(o.orgId, i.id, o.admin, body)).json).toEqual({ error: 'invalid_body' });
    }
    expect((await setRemote(o.orgId, crypto.randomUUID(), o.admin, { terminal: true, actions: false })).status).toBe(404);
  });

  it('a suspended or stopped instance only stores the values for its next start ', async () => {
    const o = await seedOrg();
    for (const status of ['suspended', 'stopped']) {
      const i = await seedInstance(o.orgId, { status });
      const res = await setRemote(o.orgId, i.id, o.admin, { terminal: true, actions: true });
      expect(res).toMatchObject({ status: 200, json: { result: 'saved' } });
      expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 1, actions_remote: 1, remote_pending: 1, pending_op: null });
    }
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg.map((a) => a.details)).toEqual([
      { from: { terminal: false, actions: false }, to: { terminal: true, actions: true }, appliesOnStart: true },
      { from: { terminal: false, actions: false }, to: { terminal: true, actions: true }, appliesOnStart: true },
    ]);
  });

  it('refuses while another operation is under way (409 instance_busy)', async () => {
    const o = await seedOrg();
    const busy = [
      await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0' }),
      await seedInstance(o.orgId, { status: 'creating' }),
      await seedInstance(o.orgId, { pending_op: 'suspend' }),
      await seedInstance(o.orgId, { pending_op: 'reconfigure' }),
      await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' }),
      await seedInstance(o.orgId, { status: 'deleting' }),
    ];
    for (const i of busy) {
      expect(await setRemote(o.orgId, i.id, o.admin, { terminal: true, actions: false })).toMatchObject({ status: 409, json: { error: 'instance_busy' } });
      expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 0 });
    }
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg).toEqual([]);
  });

  it('the same values change nothing; the same values still pending on a running instance are applied again', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { terminal_remote: 1 });
    expect(await setRemote(o.orgId, i.id, o.admin, { terminal: true, actions: false })).toMatchObject({ status: 200, json: { result: 'unchanged' } });
    expect(recorded.ops).toEqual([]);

    const failed = await seedInstance(o.orgId, { terminal_remote: 1, remote_pending: 1 });
    expect(await setRemote(o.orgId, failed.id, o.admin, { terminal: true, actions: false })).toMatchObject({ status: 200, json: { result: 'applying' } });
    expect(recorded.ops.map((p) => p.op)).toEqual(['reconfigure']);
    expect(recorded.auditOrg).toEqual([]); // no change of values to audit
  });
});

describe('decided on a stale read (auth TOCTOU)', () => {
  it('another admin turned the terminal off meanwhile: terminal:true without MFA is refused and does not enable', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { terminal_remote: 1 });
    const stale = (await getInstance(E, i.id)) as InstanceRow; // what the route read: terminal on, so "no change", no MFA
    await E.DB.prepare(`UPDATE instances SET terminal_remote = 0 WHERE id = ?`).bind(i.id).run(); // the other admin
    await expect(changeRemoteAccess(E, stale, { terminal: true, actions: false }, o.admin)).rejects.toMatchObject({ status: 409, message: 'remote_access_changed' });
    expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 0, pending_op: null });
    expect(recorded.ops).toEqual([]);
  });

  it('a write based on stale values is compare-and-set: refused, nothing enabled, on running and suspended instances', async () => {
    const o = await seedOrg();
    for (const status of ['running', 'suspended']) {
      const i = await seedInstance(o.orgId, { status, terminal_remote: 1, actions_remote: 1 });
      const stale = (await getInstance(E, i.id)) as InstanceRow;
      await E.DB.prepare(`UPDATE instances SET terminal_remote = 0 WHERE id = ?`).bind(i.id).run();
      // Turning actions off looked like no enabling (terminal "already on"): must not re-enable the terminal.
      await expect(changeRemoteAccess(E, stale, { terminal: true, actions: false }, o.admin)).rejects.toMatchObject({ status: 409, message: 'remote_access_changed' });
      expect(await instanceRow(i.id)).toMatchObject({ terminal_remote: 0, actions_remote: 1, remote_pending: 0, pending_op: null });
    }
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg).toEqual([]);
  });

  it('a busy instance with unchanged values still answers instance_busy', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0' });
    await expect(changeRemoteAccess(E, (await getInstance(E, i.id))!, { terminal: true, actions: false }, o.admin)).rejects.toMatchObject({ status: 409, message: 'instance_busy' });
  });
});

describe('a stop for abuse that lands while worca is being started wins', () => {
  /** Providers whose `method` runs stopForAbuse first, as if it landed after the step's check. */
  function racing(stub: ReturnType<typeof fakeStubFetch>, id: string, method: 'restartWorca' | 'start' | 'deploy'): Providers {
    const p = getProviders(E, stub.fetchImpl);
    const orig = p.compute[method].bind(p.compute) as (...a: unknown[]) => Promise<unknown>;
    let raced = false;
    return {
      ...p,
      compute: {
        ...p.compute,
        [method]: async (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            await stopForAbuse(E, id, { actorId: 'staff-1', reason: 'crypto mining' });
          }
          return orig(...args);
        },
      },
    };
  }
  const tail = (stub: ReturnType<typeof fakeStubFetch>) => stub.calls.map((c) => c.path.split('/').at(-1));

  it('reconfigure: worca is stopped again after the restart; the stop and its reason stay', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { terminal_remote: 1, remote_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    const ctx: OpsContext = { env: E, providers: racing(stub, i.id, 'restartWorca'), steps: immediateSteps(), pollMs: 1, maxPolls: 2 };
    expect(await runOp(ctx, { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: false, outcome: 'stopped_meanwhile' });
    expect(tail(stub)).toEqual(['variables', 'deploy', 'stop']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'stopped', stopped_reason: 'crypto mining', pending_op: null, remote_pending: 1 });
  });

  it('wake: the services are stopped again after the start', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', actions_remote: 1, remote_pending: 1 });
    const stub = fakeStubFetch();
    const ctx: OpsContext = { env: E, providers: racing(stub, i.id, 'start'), steps: immediateSteps(), pollMs: 1, maxPolls: 2 };
    expect(await runOp(ctx, { op: 'wake', instanceId: i.id })).toEqual({ ok: false, outcome: 'stopped_meanwhile' });
    expect(tail(stub)).toEqual(['variables', 'start', 'stop']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'stopped', stopped_reason: 'crypto mining', pending_op: null, remote_pending: 1 });
  });

  it('upgrade: the new version is stopped again after the deploy', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0","1.9.2"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.0', target_version: '1.9.2' });
    const stub = fakeStubFetch();
    const ctx: OpsContext = { env: E, providers: racing(stub, i.id, 'deploy'), steps: immediateSteps(), pollMs: 1, maxPolls: 2 };
    expect(await runOp(ctx, { op: 'upgrade', instanceId: i.id })).toEqual({ ok: false, outcome: 'stopped_meanwhile' });
    expect(tail(stub)).toEqual(['deploy', 'stop']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'stopped', stopped_reason: 'crypto mining', pending_op: null, target_version: null });
  });

  it('a lift is not mistaken for a stop that landed meanwhile', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped', pending_op: 'lift', stopped_reason: 'x' });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential))), { op: 'lift', instanceId: i.id });
    expect(r).toEqual({ ok: true, outcome: 'running' });
    expect(tail(stub)).toEqual(['start']);
  });
});

describe('reconfigure op', () => {
  it('sets the two variables on the worca service and restarts worca; marks them applied', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { terminal_remote: 1, actions_remote: 0, remote_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /__admin/instances/${i.id}/variables`, `POST /__admin/instances/${i.id}/deploy`, `GET /__admin/instances/${i.id}`]);
    expect(stub.calls[0]!.body).toEqual({ variables: { terminalRemote: true, actionsRemote: false, egress: { mode: 'open', allow: 'app.localhost,127.0.0.1,worca-platform-broker.railway.internal', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 }, ghAsPerson: 'prefer' } });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: null, remote_pending: 0, terminal_remote: 1 });
    expect(await gateFake().calls()).toEqual([]); // the gate keeps showing it as running
  });

  it('records phases in instance_ops', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { actions_remote: 1, remote_pending: 1, pending_op: 'reconfigure' });
    await E.DB.prepare(
      `INSERT INTO instance_ops (op_id, instance_id, org_id, kind, phase, phase_started_at, started_at, updated_at, status) VALUES ('op-rc', ?, ?, 'reconfigure', 'preparing', 1, 1, 1, 'running')`,
    )
      .bind(i.id, o.orgId)
      .run();
    await runOp({ ...opsCtx(fakeStubFetch()), opId: 'op-rc' }, { op: 'reconfigure', instanceId: i.id });
    const op = await E.DB.prepare(`SELECT * FROM instance_ops WHERE op_id = 'op-rc'`).first<Record<string, unknown>>();
    expect(op).toMatchObject({ status: 'done', outcome: 'applied', phase: 'ready' });
  });

  it('a provider failure releases the claim and keeps the values pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { terminal_remote: 1, remote_pending: 1, pending_op: 'reconfigure' });
    const failing = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const ctx: OpsContext = { env: E, providers: getProviders(E, failing), steps: immediateSteps(), pollMs: 1, maxPolls: 1 };
    await expect(runOp(ctx, { op: 'reconfigure', instanceId: i.id })).rejects.toThrow(/fake compute/);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, remote_pending: 1, terminal_remote: 1 });
  });

  it('stops without touching the provider when the instance moved on', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped', terminal_remote: 1, remote_pending: 1 });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: false, outcome: 'aborted' });
    expect(stub.calls).toEqual([]);
    expect(await instanceRow(i.id)).toMatchObject({ remote_pending: 1 });
  });
});

describe('applied on create, wake, lift and upgrade', () => {
  it('create sets both variables (off by default)', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    expect(created.json.remoteAccess).toEqual({ terminal: false, actions: false, pending: false });
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });
    await runOp(ctx, { op: 'create', instanceId: created.json.id });
    const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
    expect(vars).toMatchObject({ terminalRemote: false, actionsRemote: false });
  });

  it('wake of an instance with pending values sets them, starts worca from its configuration, clears pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', actions_remote: 1, remote_pending: 1 });
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub, async () => void (await sendBeat(i.credential)));
    expect(await runOp(ctx, { op: 'wake', instanceId: i.id })).toEqual({ ok: true, outcome: 'running' });
    expect(stub.calls.map((c) => c.path)).toEqual([`/__admin/instances/${i.id}/variables`, `/__admin/instances/${i.id}/start`]);
    expect(stub.calls[0]!.body.variables).toEqual({ terminalRemote: false, actionsRemote: true, egress: { mode: 'open', allow: 'app.localhost,127.0.0.1,worca-platform-broker.railway.internal', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 }, ghAsPerson: 'prefer' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', remote_pending: 0, actions_remote: 1 });
  });

  it('lift applies pending values too; a wake without pending values sets nothing', async () => {
    const o = await seedOrg();
    const lifted = await seedInstance(o.orgId, { status: 'stopped', pending_op: 'lift', terminal_remote: 1, remote_pending: 1 });
    const stub = fakeStubFetch();
    await runOp(opsCtx(stub, async () => void (await sendBeat(lifted.credential))), { op: 'lift', instanceId: lifted.id });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'start']);
    expect(await instanceRow(lifted.id)).toMatchObject({ remote_pending: 0 });

    const plain = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', terminal_remote: 1 });
    const stub2 = fakeStubFetch();
    await runOp(opsCtx(stub2, async () => void (await sendBeat(plain.credential))), { op: 'wake', instanceId: plain.id });
    expect(stub2.calls.map((c) => c.path.split('/').at(-1))).toEqual(['start']);
  });

  it('upgrade applies pending values before the deploy; without pending it only deploys', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0","1.9.2"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.0', target_version: '1.9.2', terminal_remote: 1, remote_pending: 1 });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential, beat({ version: '1.9.2' })))), { op: 'upgrade', instanceId: i.id });
    expect(r).toEqual({ ok: true, outcome: 'upgraded' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'deploy']);
    expect(stub.calls[0]!.body.variables).toEqual({ terminalRemote: true, actionsRemote: false, egress: { mode: 'open', allow: 'app.localhost,127.0.0.1,worca-platform-broker.railway.internal', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 }, ghAsPerson: 'prefer' });
    expect((await getInstance(E, i.id))!.remote_pending).toBe(0);

    const plain = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.0', target_version: '1.9.2', terminal_remote: 1 });
    const stub2 = fakeStubFetch();
    await runOp(opsCtx(stub2, async () => void (await sendBeat(plain.credential, beat({ version: '1.9.2' })))), { op: 'upgrade', instanceId: plain.id });
    expect(stub2.calls.map((c) => c.path.split('/').at(-1))).toEqual(['deploy']);
  });
});

describe('railway provider: remote access', () => {
  const env = { RAILWAY_TOKEN: 'rw-token', RAILWAY_WORKSPACE_ID: 'ws-1', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;
  const ref: ComputeRef = {
    projectId: 'proj-1',
    environmentId: 'env-1',
    services: { worca: { serviceId: 'svc-worca' }, broker: { serviceId: 'svc-broker' }, cloudflared: { serviceId: 'svc-cloudflared' } },
  };
  function fakeRailway(o: { failDeletes?: boolean; keepLegacy?: boolean; failUpsert?: boolean; hold?: Record<string, string>; deploymentStatus?: string } = {}) {
    const calls: { op: string; variables: Record<string, any> }[] = [];
    // What Railway holds on the worca service: what was upserted, unless `hold` overrides it.
    let held: Record<string, string> = { WORCA_EGRESS_ALLOWLIST: 'github.com', SECRET: 'x' };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.operationName === 'projectName') return Response.json({ data: { project: { id: 'proj-1', name: 'worca-run-0123456789abcdef012345' } } });
      calls.push({ op: body.operationName, variables: body.variables });
      if (body.operationName === 'variableCollectionUpsert') {
        if (o.failUpsert) return Response.json({ errors: [{ message: 'refused' }] });
        held = { ...held, ...body.variables.input.variables, ...o.hold };
        return Response.json({ data: { variableCollectionUpsert: true } });
      }
      if (body.operationName === 'variableDelete') {
        if (!o.keepLegacy) delete held[body.variables.input.name];
        return o.failDeletes ? Response.json({ errors: [{ message: 'Variable not found' }] }) : Response.json({ data: { variableDelete: true } });
      }
      if (body.operationName === 'variables') return Response.json({ data: { variables: held } });
      if (body.operationName === 'serviceInstanceLimitsUpdate') return Response.json({ data: { serviceInstanceLimitsUpdate: true } });
      if (body.operationName === 'deploymentStatus') return Response.json({ data: { deployment: { id: body.variables.id, status: o.deploymentStatus ?? 'SUCCESS' } } });
      if (body.operationName === 'serviceInstanceDeployV2') return Response.json({ data: { serviceInstanceDeployV2: 'dep-new' } });
      if (body.operationName === 'latestDeployment') return Response.json({ data: { deployments: { edges: [{ node: { id: `dep-${body.variables.input.serviceId}`, status: 'SUCCESS', deploymentStopped: true } }] } } });
      if (body.operationName === 'deploymentRedeploy') return Response.json({ data: { deploymentRedeploy: { id: `re-${body.variables.id}`, status: 'INITIALIZING' } } });
      throw new Error(`unexpected ${body.operationName}`);
    }) as unknown as typeof fetch;
    return { calls, provider: createRailwayProvider(env, fetchImpl, { sleep: async () => {} }) };
  }

  it('setWorcaSettings writes all seven in one upsert first, sets the size\'s limits, deletes the old allowlist, then reads them back', async () => {
    const { calls, provider } = fakeRailway();
    const settings = { terminalRemote: true, actionsRemote: false, egress: { mode: 'block' as const, allow: 'app.worca.dev', deny: '.ngrok.io' }, size: { cpu: 4, memoryMb: 8192, maxParallel: 6, maxParallelScripts: 3 } };
    await provider.setWorcaSettings(ref, settings);
    const target = { projectId: 'proj-1', environmentId: 'env-1', serviceId: 'svc-worca' };
    const want = {
      WORCA_TERMINAL_REMOTE: '1', WORCA_ACTIONS_REMOTE: '0', WORCA_EGRESS_MODE: 'block', WORCA_EGRESS_ALLOW: 'app.worca.dev', WORCA_EGRESS_DENY: '.ngrok.io',
      WORCA_MAX_PARALLEL: '6', WORCA_MAX_PARALLEL_SCRIPTS: '3',
    };
    expect(calls).toEqual([
      { op: 'variableCollectionUpsert', variables: { input: { ...target, variables: want, skipDeploys: true } } },
      { op: 'serviceInstanceLimitsUpdate', variables: { input: { serviceId: 'svc-worca', environmentId: 'env-1', vCPUs: 4, memoryGB: 8 } } },
      { op: 'variableDelete', variables: { input: { ...target, name: 'WORCA_EGRESS_ALLOWLIST' } } },
      { op: 'variables', variables: target },
    ]);
  });

  it('setWorcaSettings: an already deleted old allowlist is fine', async () => {
    const { calls, provider } = fakeRailway({ failDeletes: true });
    await provider.setWorcaSettings(ref, { terminalRemote: false, actionsRemote: false, egress: { mode: 'open', allow: 'app.worca.dev', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 } });
    expect(calls.map((c) => c.op)).toEqual(['variableCollectionUpsert', 'serviceInstanceLimitsUpdate', 'variableDelete', 'variables']);
  });

  it('setWorcaSettings fails (so the settings stay pending) when Railway does not hold exactly what was written', async () => {
    // A write that didn't take: the read-back still has the old, more open policy.
    const stale = fakeRailway({ hold: { WORCA_EGRESS_MODE: 'open' } });
    await expect(stale.provider.setWorcaSettings(ref, { terminalRemote: false, actionsRemote: false, egress: { mode: 'allow', allow: 'app.worca.dev', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 } }))
      .rejects.toThrow(/not confirmed on the worca service: WORCA_EGRESS_MODE$/);
    // The old allowlist survived its delete.
    const legacy = fakeRailway({ failDeletes: true, keepLegacy: true });
    await expect(legacy.provider.setWorcaSettings(ref, { terminalRemote: false, actionsRemote: false, egress: { mode: 'open', allow: 'app.worca.dev', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 } }))
      .rejects.toThrow(/WORCA_EGRESS_ALLOWLIST \(still set\)/);
    // The upsert itself refused: nothing deleted, nothing read; the error goes up.
    const refused = fakeRailway({ failUpsert: true });
    await expect(refused.provider.setWorcaSettings(ref, { terminalRemote: false, actionsRemote: false, egress: { mode: 'open', allow: 'a.b', deny: '.invalid' }, size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 } })).rejects.toThrow(/variableCollectionUpsert/);
    expect(refused.calls.map((c) => c.op)).toEqual(['variableCollectionUpsert']);
  });

  it('worcaDeploymentState reads the deployment restartWorca made', async () => {
    for (const [status, state] of [['SUCCESS', 'running'], ['DEPLOYING', 'starting'], ['BUILDING', 'starting'], ['FAILED', 'failed'], ['CRASHED', 'failed'], ['REMOVED', 'failed']] as const) {
      const { calls, provider } = fakeRailway({ deploymentStatus: status });
      expect(await provider.worcaDeploymentState({ ...ref, services: { ...ref.services, worca: { serviceId: 'svc-worca', deploymentId: 'dep-new' } } })).toBe(state);
      expect(calls).toEqual([{ op: 'deploymentStatus', variables: { id: 'dep-new' } }]);
    }
    expect(await fakeRailway().provider.worcaDeploymentState(ref)).toBe('failed'); // no deployment to confirm
  });

  it('restartWorca deploys the worca service only; start can deploy worca from its configuration', async () => {
    const { calls, provider } = fakeRailway();
    const out = await provider.restartWorca(ref);
    expect(calls).toEqual([{ op: 'serviceInstanceDeployV2', variables: { serviceId: 'svc-worca', environmentId: 'env-1' } }]);
    expect(out.services).toEqual({ ...ref.services, worca: { serviceId: 'svc-worca', deploymentId: 'dep-new' } });

    calls.length = 0;
    await provider.start(ref, { worcaFromConfig: true });
    expect(calls.map((c) => c.op)).toEqual(['serviceInstanceDeployV2', 'latestDeployment', 'deploymentRedeploy', 'latestDeployment', 'deploymentRedeploy']);
    expect(calls[0]!.variables.serviceId).toBe('svc-worca');
  });
});

// T8 progress rows, T5 health_since, T4 summary, T1 team names, P2/P6 platform ops, G1 wake phase.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../packages/platform/src/control/env';
import { startOp } from '../../../packages/platform/src/control/instances/api';
import { CRON_STALE, markStale, runCrons } from '../../../packages/platform/src/control/instances/crons';
import { runOp, trackedSteps, type OpsContext, type StepRunner } from '../../../packages/platform/src/control/instances/ops';
import { platformOpsApp, STUCK_AFTER_MS } from '../../../packages/platform/src/control/instances/platform-ops-routes';
import { OP_PHASES, pruneOps, wakePhase, type OpRow } from '../../../packages/platform/src/control/instances/progress';
import { getProviders } from '../../../packages/platform/src/control/providers';
import { beat, E, fakeStubFetch, gateFake, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });

const latestOp = (instanceId: string) =>
  E.DB.prepare(`SELECT * FROM instance_ops WHERE instance_id = ? ORDER BY started_at DESC LIMIT 1`).bind(instanceId).first<OpRow>();

/** Immediate steps that also record the op's phase after every step. */
function phaseSteps(instanceId: string, onSleep?: () => Promise<void>): StepRunner & { phases: string[] } {
  const phases: string[] = [];
  return {
    phases,
    async do(_name, fn) {
      const r = await fn();
      const p = (await latestOp(instanceId))!.phase;
      if (phases.at(-1) !== p) phases.push(p);
      return r;
    },
    async sleep() {
      await onSleep?.();
    },
  };
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('operation progress (T8)', () => {
  it('create: a row from the route, phases from every step, done on the first heartbeat', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const id = created.json.id as string;
    expect(created.json.op).toMatchObject({ kind: 'create', phase: 'reserving', status: 'running', phases: OP_PHASES.create });
    const row = (await latestOp(id))!;
    expect(row).toMatchObject({ kind: 'create', org_id: o.orgId, workflow_id: 'test-create', status: 'running' });

    const stub = fakeStubFetch();
    const steps = phaseSteps(id, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential);
    });
    const ctx: OpsContext = { env: E, providers: getProviders(E, stub.fetchImpl), steps, pollMs: 1, maxPolls: 3, opId: row.op_id };
    expect(await runOp(ctx, { op: 'create', instanceId: id })).toEqual({ ok: true, outcome: 'running' });
    // Monotonic: the steps run in phase order.
    expect(steps.phases).toEqual(['reserving', 'compute', 'network', 'starting', 'waiting', 'ready']);
    expect(await latestOp(id)).toMatchObject({ status: 'done', outcome: 'running', phase: 'ready', step_running: 0, attempts: 1 });
    expect((await latestOp(id))!.finished_at).toBeGreaterThan(0);

    const detail = await app.call('GET', `/api/orgs/${o.orgId}/instances/${id}`, { user: o.admin });
    expect(detail.json.op).toEqual({
      kind: 'create', phase: 'ready', phases: OP_PHASES.create, status: 'done',
      startedAt: row.started_at, phaseStartedAt: expect.any(Number), finishedAt: expect.any(Number),
      problem: null, problemSource: null,
    });
    // Tenant-safe: no ids, steps or errors of the operation.
    expect(JSON.stringify(detail.json.op)).not.toMatch(/test-create|workflow|step|error/);
  });

  it('counts attempts of a retried step and records its error; a failure marks the op failed', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    await startOp(E, { op: 'wake', instanceId: i.id });
    const op = (await latestOp(i.id))!;
    expect(op).toMatchObject({ kind: 'wake', phase: 'starting', status: 'running' });

    // A runner that retries each step up to 3 times, like the Workflow does.
    const retrying: StepRunner = {
      async do(_name, fn) {
        let last: unknown;
        for (let n = 0; n < 3; n++) {
          try {
            return await fn();
          } catch (err) {
            last = err;
          }
        }
        throw last;
      },
      async sleep() {},
    };
    let fails = 1;
    const steps = trackedSteps(E, op.op_id, 'wake', retrying);
    await steps.do('start services', async () => {
      if (fails-- > 0) throw new Error('railway deploymentRedeploy: boom');
      expect(await latestOp(i.id)).toMatchObject({ attempts: 2, last_error: 'railway deploymentRedeploy: boom', step: 'start services' });
      return true;
    });
    expect(await latestOp(i.id)).toMatchObject({ attempts: 2, last_error: null, step_running: 0 });

    // Every attempt fails: the run throws and the op is failed with the error.
    const failing = { ...getProviders(E, fakeStubFetch().fetchImpl) };
    failing.compute = { ...failing.compute, start: async () => { throw new Error('railway: down'); } };
    const ctx: OpsContext = { env: E, providers: failing, steps: retrying, pollMs: 1, maxPolls: 1, opId: op.op_id };
    await expect(runOp(ctx, { op: 'wake', instanceId: i.id })).rejects.toThrow('railway: down');
    expect(await latestOp(i.id)).toMatchObject({ status: 'failed', outcome: 'error', last_error: 'railway: down', attempts: 3, phase: 'starting' });
  });

  it('a superseded op is done, a timed-out one failed', async () => {
    const o = await seedOrg();
    const gone = await seedInstance(o.orgId, { status: 'deleting' });
    await startOp(E, { op: 'create', instanceId: gone.id });
    const ctx = (opId: string, maxPolls = 1): OpsContext => ({
      env: E, providers: getProviders(E, fakeStubFetch().fetchImpl), steps: phaseSteps(gone.id), pollMs: 1, maxPolls, opId,
    });
    expect(await runOp(ctx((await latestOp(gone.id))!.op_id), { op: 'create', instanceId: gone.id })).toEqual({ ok: false, outcome: 'aborted' });
    expect(await latestOp(gone.id)).toMatchObject({ status: 'done', outcome: 'aborted' });

    const waking = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    await startOp(E, { op: 'wake', instanceId: waking.id });
    const op = (await latestOp(waking.id))!;
    const r = await runOp({ ...ctx(op.op_id), steps: phaseSteps(waking.id) }, { op: 'wake', instanceId: waking.id });
    expect(r).toEqual({ ok: false, outcome: 'wake_timeout' });
    expect(await latestOp(waking.id)).toMatchObject({ status: 'failed', last_error: 'wake_timeout', phase: 'waiting' });
  });

  it('G1: wakePhase follows the running wake', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    expect(await wakePhase(E, i.id)).toBeNull();
    await startOp(E, { op: 'wake', instanceId: i.id });
    expect(await wakePhase(E, i.id)).toBe('starting');
    const op = (await latestOp(i.id))!;
    await trackedSteps(E, op.op_id, 'wake', phaseSteps(i.id)).do('heartbeat: check', async () => 'wait');
    expect(await wakePhase(E, i.id)).toBe('waiting');
    await E.DB.prepare(`UPDATE instance_ops SET status = 'done' WHERE op_id = ?`).bind(op.op_id).run();
    expect(await wakePhase(E, i.id)).toBeNull();
  });

  it('prunes finished ops after 30 days', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await startOp(E, { op: 'suspend', instanceId: i.id });
    const op = (await latestOp(i.id))!;
    await E.DB.prepare(`UPDATE instance_ops SET finished_at = 1, status = 'done' WHERE op_id = ?`).bind(op.op_id).run();
    expect(await pruneOps(E)).toBeGreaterThanOrEqual(1);
    expect(await latestOp(i.id)).toBeNull();
  });
});

describe('create with a policy (T8)', () => {
  it('stores the required methods and audits them', async () => {
    const o = await seedOrg();
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA, policy: { requiredMethods: ['passkey', 'passkey'] } } });
    expect(r.status).toBe(201);
    const p = await E.DB.prepare(`SELECT required_methods FROM instance_login_policies WHERE instance_id = ?`).bind(r.json.id).first<{ required_methods: string }>();
    expect(JSON.parse(p!.required_methods)).toEqual(['passkey']);
    expect(recorded.auditOrg.map((a) => a.action)).toEqual(['instance.create_started', 'instance.policy_updated']);
  });

  it('refuses a policy that does not narrow the org policy, and unknown methods', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT INTO org_login_policies (org_id, allowed_methods, updated_at) VALUES (?, '["email-otp"]', 1)`).bind(o.orgId).run();
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'x', teamId: o.teamA, policy: { requiredMethods: ['passkey'] } } });
    expect(r).toEqual({ status: 400, json: { error: 'not_narrowing' } });
    const bad = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'x', teamId: o.teamA, policy: { requiredMethods: ['password'] } } });
    expect(bad.status).toBe(400);
    expect((await E.DB.prepare(`SELECT COUNT(*) AS n FROM instances WHERE org_id = ?`).bind(o.orgId).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('health_since (T5)', () => {
  it('moves only when health changes, from beats and the stale cron', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { health: null, health_since: null });
    await sendBeat(i.credential);
    const first = (await instanceRow(i.id))!.health_since as number;
    expect(first).toBeGreaterThan(0);
    await sendBeat(i.credential);
    expect((await instanceRow(i.id))!.health_since).toBe(first);
    await sendBeat(i.credential, beat({ health: 'degraded' }));
    const degraded = (await instanceRow(i.id))!.health_since as number;
    expect(degraded).toBeGreaterThanOrEqual(first);
    expect((await instanceRow(i.id))!.health).toBe('degraded');

    const silent = await seedInstance(o.orgId, { last_heartbeat_at: 1000, health: 'ok', health_since: 500 });
    await markStale(E, 2_000_000);
    expect(await instanceRow(silent.id)).toMatchObject({ health: 'degraded', health_since: 2_000_000 });
    const listed = await app.call('GET', `/api/orgs/${o.orgId}/instances/${silent.id}`, { user: o.admin });
    expect(listed.json.healthSince).toBe(2_000_000);
  });
});

describe('instance view (T1)', () => {
  it('carries the names of the granting teams', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await E.DB.prepare(`UPDATE team SET name = 'Platform' WHERE id = ?`).bind(o.teamA).run();
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamA).run();
    const r = await app.call('GET', `/api/orgs/${o.orgId}/instances`, { user: o.user });
    expect(r.json.instances[0]).toMatchObject({ teamIds: [o.teamA], teams: [{ id: o.teamA, name: 'Platform' }], op: null });
  });
});

describe('org summary (T4)', () => {
  it('counts instances, upgrades, degraded, members, invitations and the sign-in policy', async () => {
    const o = await seedOrg();
    const now = Date.now();
    await seedInstance(o.orgId, { available_version: '1.9.0' });
    const sick = await seedInstance(o.orgId, { health: 'degraded', health_since: now - 60_000 });
    await seedInstance(o.orgId, { status: 'suspended' });
    await seedInstance(o.orgId, { status: 'deleting' });
    const inv = (id: string, expiresAt: string, status = 'pending') =>
      E.DB.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES (?, ?, 'enc:x', 'tenant_user', ?, ?, ?, ?)`)
        .bind(id, o.orgId, status, expiresAt, new Date(now).toISOString(), o.admin);
    await E.DB.batch([
      inv(crypto.randomUUID(), new Date(now + 3_600_000).toISOString()), // expiring soon
      inv(crypto.randomUUID(), new Date(now + 5 * 86_400_000).toISOString()),
      inv(crypto.randomUUID(), new Date(now - 1000).toISOString()), // expired
      inv(crypto.randomUUID(), new Date(now + 3_600_000).toISOString(), 'accepted'),
      E.DB.prepare(`INSERT INTO org_login_policies (org_id, allowed_methods, updated_at) VALUES (?, '["passkey","sso"]', 1)`).bind(o.orgId),
    ]);

    const r = await app.call('GET', `/api/orgs/${o.orgId}/summary`, { user: o.admin });
    expect(r.status).toBe(200);
    expect(r.json.instances).toMatchObject({ byStatus: { running: 2, suspended: 1, deleting: 1 }, total: 3, limit: 1 });
    expect(r.json.instances.upgradesAvailable).toEqual([expect.objectContaining({ version: '1.8.0', availableVersion: '1.9.0', name: 'Main' })]);
    expect(r.json.instances.degraded).toEqual([{ id: sick.id, name: 'Main', healthSince: now - 60_000, lastHeartbeatAt: expect.any(Number) }]);
    expect(r.json.members.count).toBe(4);
    expect(r.json.invitations).toEqual({ open: 2, expiringWithin48h: 1 });
    expect(r.json.signIn).toEqual({ allowedMethods: ['passkey', 'sso'], requiredDomain: null, instanceOverrides: 0, ssoProviders: 0 });

    expect((await app.call('GET', `/api/orgs/${o.orgId}/summary`, { user: o.user })).status).toBe(403);
    expect((await app.call('GET', `/api/orgs/${o.orgId}/summary`, { user: (await seedOrg()).admin })).status).toBe(404);
  });
});

describe('platform ops (P2, P6)', () => {
  function platformApp() {
    const a = new Hono<AppContext>();
    a.use('*', async (c, next) => {
      const id = c.req.header('x-test-user');
      if (id) {
        c.set('user', { id, email: `${id}@example.com`, name: id, status: 'active' });
        c.set('session', { id: `s-${id}`, userId: id, method: 'passkey', mfa: true, expiresAt: Date.now() + 3_600_000, activeOrganizationId: null, ssoOrgId: null });
      }
      await next();
    });
    a.route('/api/platform', platformOpsApp);
    a.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 500) as 400));
    return async (method: string, path: string, user?: string) => {
      const res = await a.request(path, { method, headers: user ? { 'x-test-user': user } : {} }, E);
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
  }
  const staff = async (role: string) => {
    const id = crypto.randomUUID();
    await E.DB.prepare(`INSERT INTO platform_roles (user_id, role, granted_at) VALUES (?, ?, 1)`).bind(id, role).run();
    return id;
  };

  it('lists stuck, failed and running operations, and restarts one with an audit', async () => {
    const call = platformApp();
    const o = await seedOrg();
    const now = Date.now();
    const a = await seedInstance(o.orgId, { status: 'creating' });
    const b = await seedInstance(o.orgId);
    const c = await seedInstance(o.orgId);
    await startOp(E, { op: 'create', instanceId: a.id });
    await startOp(E, { op: 'upgrade', instanceId: b.id });
    await startOp(E, { op: 'suspend', instanceId: c.id });
    const [opA, opB, opC] = [(await latestOp(a.id))!, (await latestOp(b.id))!, (await latestOp(c.id))!];
    await E.DB.batch([
      E.DB.prepare(`UPDATE instance_ops SET phase = 'waiting', phase_started_at = ?, attempts = 1 WHERE op_id = ?`).bind(now - STUCK_AFTER_MS - 1000, opA.op_id),
      E.DB.prepare(`UPDATE instance_ops SET status = 'failed', finished_at = ?, last_error = 'railway: down' WHERE op_id = ?`).bind(now, opB.op_id),
    ]);
    const support = await staff('support');
    const admin = await staff('admin');

    const stuck = await call('GET', '/api/platform/ops?state=stuck', support);
    expect(stuck.status).toBe(200);
    const mine = stuck.json.ops.filter((x: { opId: string }) => [opA.op_id, opB.op_id, opC.op_id].includes(x.opId));
    expect(mine).toEqual([
      expect.objectContaining({ opId: opA.op_id, instanceId: a.id, orgId: o.orgId, kind: 'create', phase: 'waiting', attempts: 1, stuck: true }),
    ]);
    expect(mine[0].inPhaseMs).toBeGreaterThanOrEqual(STUCK_AFTER_MS);
    const failed = await call('GET', '/api/platform/ops?state=failed', support);
    expect(failed.json.ops.find((x: { opId: string }) => x.opId === opB.op_id)).toMatchObject({ kind: 'upgrade', lastError: 'railway: down', status: 'failed' });
    const running = await call('GET', '/api/platform/ops?state=running', support);
    const runningIds = running.json.ops.map((x: { opId: string }) => x.opId);
    expect(runningIds).toEqual(expect.arrayContaining([opA.op_id, opC.op_id]));
    expect(runningIds).not.toContain(opB.op_id);
    expect((await call('GET', '/api/platform/ops?state=nope', support)).status).toBe(400);
    expect((await call('GET', '/api/platform/ops')).status).toBe(401);
    expect((await call('GET', '/api/platform/ops', crypto.randomUUID())).status).toBe(403);

    // Restart: instances.stop (admin+), not support.
    expect((await call('POST', `/api/platform/ops/${opB.op_id}/restart`, support)).status).toBe(403);
    const restarted = await call('POST', `/api/platform/ops/${opB.op_id}/restart`, admin);
    expect(restarted).toEqual({ status: 202, json: { ok: true, opId: opB.op_id, status: 'running' } });
    expect(recorded.restarts).toEqual(['test-upgrade']);
    expect(await latestOp(b.id)).toMatchObject({ status: 'running', finished_at: null, attempts: 0 });
    expect(recorded.auditPlatform.at(-1)).toMatchObject({ actorId: admin, actorRole: 'admin', action: 'instance.op_restarted', targetId: b.id });
    expect(recorded.auditOrg.at(-1)).toMatchObject({ orgId: o.orgId, actorScope: 'platform', action: 'instance.op_restarted' });

    await E.DB.prepare(`UPDATE instance_ops SET status = 'done' WHERE op_id = ?`).bind(opC.op_id).run();
    expect((await call('POST', `/api/platform/ops/${opC.op_id}/restart`, admin)).json).toEqual({ error: 'op_finished' });
    expect((await call('POST', `/api/platform/ops/nope/restart`, admin)).status).toBe(404);
  });
});

describe('crons', () => {
  it('the 5-minute tick polls the providers once', async () => {
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime: Date.UTC(2031, 0, 1, 0, 5) }), E, createExecutionContext());
    expect(recorded.providerPolls).toBe(1);
  });
});

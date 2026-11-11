// D74: renewing an instance's credentials. The staff routes, the rotate op, and the heartbeat
// accepting the old credential until the instance reports in with the new one.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../packages/platform/src/control/env';
import { sha256Hex } from '../../../packages/platform/src/control/keys-api';
import { ROTATE_SPACING_MS } from '../../../packages/platform/src/control/instances/api';
import { PREV_CREDENTIAL_GRACE_MS, runOp, type OpsContext, type StepRunner } from '../../../packages/platform/src/control/instances/ops';
import { platformOpsApp } from '../../../packages/platform/src/control/instances/platform-ops-routes';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import { beat, E, fakeStubFetch, gateFake, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string) => app.call('POST', '/api/heartbeat', { body: beat(), headers: { authorization: `Bearer ${credential}` } });

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

function platformCall() {
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
  return async (method: string, path: string, user?: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) };
    const res = await a.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, E);
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
}

const staff = async (role: string) => {
  const id = crypto.randomUUID();
  await E.DB.prepare(`INSERT INTO platform_roles (user_id, role, granted_at) VALUES (?, ?, 1)`).bind(id, role).run();
  return id;
};

/** Immediate steps that keep every step's result, to check that no secret is among them. */
function keptSteps(onSleep?: (name: string) => Promise<void>): StepRunner & { names: string[]; results: unknown[] } {
  const names: string[] = [];
  const results: unknown[] = [];
  return {
    names,
    results,
    async do(name, fn) {
      names.push(name);
      const r = await fn();
      results.push(r);
      return r;
    },
    async sleep(name) {
      names.push(name);
      await onSleep?.(name);
    },
  };
}

function ctxWith(steps: StepRunner, providers: Providers, maxPolls = 3): OpsContext {
  return { env: E, providers, steps, pollMs: 1, maxPolls };
}

/** The secrets the op sent to the (stub) compute provider. */
const sentSecrets = (stub: ReturnType<typeof fakeStubFetch>) => stub.calls.find((c) => c.path.endsWith('/variables'))?.body.variables;

describe('rotate routes (D74)', () => {
  it('staff with instances.rotate start a rotation; busy, unknown and support are refused', async () => {
    const call = platformCall();
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const admin = await staff('admin');

    expect((await call('POST', `/api/platform/instances/${i.id}/rotate`, await staff('support'))).status).toBe(403);
    const res = await call('POST', `/api/platform/instances/${i.id}/rotate`, admin);
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(recorded.ops).toEqual([{ op: 'rotate', instanceId: i.id, actorId: admin }]);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: 'rotate', status: 'running' });
    expect(recorded.auditPlatform).toMatchObject([{ action: 'instance.rotate_started', targetId: i.id, actorRole: 'admin', details: { orgId: o.orgId, status: 'running' } }]);
    expect(recorded.auditOrg).toMatchObject([{ action: 'instance.rotate_started', actorScope: 'platform', targetId: i.id, details: { status: 'running' } }]);

    expect((await call('POST', `/api/platform/instances/${i.id}/rotate`, admin)).json).toEqual({ error: 'instance_busy' });
    const creating = await seedInstance(o.orgId, { status: 'creating' });
    expect((await call('POST', `/api/platform/instances/${creating.id}/rotate`, admin)).json).toEqual({ error: 'instance_busy' });
    expect((await call('POST', `/api/platform/instances/nope/rotate`, admin)).status).toBe(404);
    expect(recorded.ops).toHaveLength(1);
  });

  it('every instance at once: needs the typed phrase, starts the free ones spread out and lists the rest', async () => {
    const call = platformCall();
    await E.DB.prepare(`DELETE FROM instances`).run();
    const o = await seedOrg();
    const at = (n: number) => ({ created_at: n });
    const running = await seedInstance(o.orgId, at(1));
    const suspended = await seedInstance(o.orgId, { ...at(2), status: 'suspended' });
    const stopped = await seedInstance(o.orgId, { ...at(3), status: 'stopped' });
    const upgrading = await seedInstance(o.orgId, { ...at(4), status: 'upgrading' });
    const busy = await seedInstance(o.orgId, { ...at(5), pending_op: 'reconfigure' });
    const admin = await staff('superadmin');

    expect((await call('POST', '/api/platform/instances/rotate', admin, { confirm: 'yes' })).json).toEqual({ error: 'confirm_name_mismatch' });
    expect(recorded.ops).toEqual([]);

    const res = await call('POST', '/api/platform/instances/rotate', admin, { confirm: 'All instances' });
    expect(res.status).toBe(200);
    expect(res.json.started).toEqual([running.id, suspended.id, stopped.id]);
    expect(res.json.skipped).toEqual([
      { id: upgrading.id, status: 'upgrading', pendingOp: null },
      { id: busy.id, status: 'running', pendingOp: 'reconfigure' },
    ]);
    expect(recorded.ops.map((p) => [p.instanceId, p.staggerMs ?? 0])).toEqual([
      [running.id, 0],
      [suspended.id, ROTATE_SPACING_MS],
      [stopped.id, 2 * ROTATE_SPACING_MS],
    ]);
    expect(recorded.auditPlatform.at(-1)).toMatchObject({ action: 'instances.rotate_all_started', details: { started: 3, skipped: 2 } });
  });
});

describe('rotate op (D74)', () => {
  it('running: new secrets, a restart, the old credential accepted until the first new beat, then the tunnel', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'rotate' });
    const stub = fakeStubFetch();
    const providers = getProviders(E, stub.fetchImpl);
    const seen: number[] = [];
    const steps = keptSteps(async () => {
      // While the services restart, the old credential still works; the new one retires it.
      seen.push((await sendBeat(i.credential)).status);
      expect((await instanceRow(i.id))!.heartbeat_cred_hash_prev).toBe(await sha256Hex(i.credential));
      seen.push((await sendBeat(sentSecrets(stub).heartbeatCredential)).status);
    });

    expect(await runOp(ctxWith(steps, providers), { op: 'rotate', instanceId: i.id, actorId: 'staff-1' })).toEqual({ ok: true, outcome: 'rotated' });
    expect(seen).toEqual([200, 200]);

    const sent = sentSecrets(stub);
    expect(Object.keys(sent).sort()).toEqual(['brokerSecret', 'heartbeatCredential', 'tunnelToken']);
    expect(sent.tunnelToken).toMatch(/^fake-tunnel-token-t-/);
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /__admin/instances/${i.id}/variables`, `POST /__admin/instances/${i.id}/deploy`]);
    // The first check finds no new beat yet; the beats arrive during its wait.
    expect(steps.names).toEqual(['load', 'renew secrets', 'restart services', 'new credential: check', 'new credential: wait', 'new credential: check', 'tunnel: check', 'finish']);

    const row = (await instanceRow(i.id))!;
    expect(row).toMatchObject({ status: 'running', pending_op: null, heartbeat_cred_hash_prev: null, heartbeat_cred_prev_until: null, heartbeat_cred_hash: await sha256Hex(sent.heartbeatCredential) });
    expect(row.secrets_rotated_at).toBeGreaterThan(0);
    expect((await sendBeat(i.credential)).status).toBe(401);

    // Nothing secret in any step's stored result.
    const stored = JSON.stringify(steps.results);
    for (const v of Object.values(sent) as string[]) expect(stored).not.toContain(v);
    expect(recorded.auditOrg).toMatchObject([{ action: 'instance.secrets_rotated', actorId: 'staff-1', details: { restarted: true } }]);
    expect(recorded.mails).toMatchObject([{ to: `${o.admin}@example.com`, subject: 'Worca Main was restarted to renew its credentials' }]);
  });

  it('suspended or stopped: only new values, the old credential goes at once, no restart and no mail', async () => {
    const o = await seedOrg();
    for (const status of ['suspended', 'stopped']) {
      recorded.mails.length = 0;
      const i = await seedInstance(o.orgId, { status, pending_op: 'rotate' });
      const stub = fakeStubFetch();
      const steps = keptSteps();
      expect(await runOp(ctxWith(steps, getProviders(E, stub.fetchImpl)), { op: 'rotate', instanceId: i.id })).toEqual({ ok: true, outcome: 'rotated' });
      expect(stub.calls.map((c) => c.path)).toEqual([`/__admin/instances/${i.id}/variables`]);
      expect(steps.names).toEqual(['load', 'renew secrets', 'finish']);
      expect(await instanceRow(i.id)).toMatchObject({ status, pending_op: null, heartbeat_cred_hash_prev: null, heartbeat_cred_hash: await sha256Hex(sentSecrets(stub).heartbeatCredential) });
      expect(recorded.mails).toEqual([]);
    }
  });

  it('waits out its stagger first', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'rotate' });
    const steps = keptSteps();
    await runOp(ctxWith(steps, getProviders(E, fakeStubFetch().fetchImpl)), { op: 'rotate', instanceId: i.id, staggerMs: 30_000 });
    expect(steps.names[0]).toBe('stagger');
  });

  it('no beat with the new credential in time: fails and releases the claim; the old credential works only until its grace ends', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'rotate' });
    const stub = fakeStubFetch();
    const before = Date.now();
    await expect(runOp(ctxWith(keptSteps(), getProviders(E, stub.fetchImpl), 2), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/did not report in/);
    const row = (await instanceRow(i.id))!;
    expect(row).toMatchObject({ pending_op: null, heartbeat_cred_hash_prev: await sha256Hex(i.credential), secrets_rotated_at: null });
    expect(row.heartbeat_cred_prev_until).toBeGreaterThanOrEqual(before + PREV_CREDENTIAL_GRACE_MS);
    expect((await sendBeat(i.credential)).status).toBe(200);
    // Once the grace is over, a possibly leaked old credential is refused (fail closed)...
    await E.DB.prepare(`UPDATE instances SET heartbeat_cred_prev_until = ? WHERE id = ?`).bind(Date.now() - 1, i.id).run();
    expect((await sendBeat(i.credential)).status).toBe(401);
    // ...and the new one, which Railway already holds, works whenever worca restarts with it.
    expect((await sendBeat(sentSecrets(stub).heartbeatCredential)).status).toBe(200);
    expect(await instanceRow(i.id)).toMatchObject({ heartbeat_cred_hash_prev: null, heartbeat_cred_prev_until: null });
  });

  it('a retried renew step keeps the credential the instance really runs with', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'rotate' });
    const stub = fakeStubFetch();
    const base = getProviders(E, stub.fetchImpl);
    let failOnce = true;
    const providers: Providers = {
      ...base,
      compute: {
        ...base.compute,
        // Restart fails the first time, after the renew step already ran once.
        async restartServices(ref) {
          if (failOnce) {
            failOnce = false;
            throw new Error('railway: try again');
          }
          return base.compute.restartServices(ref);
        },
      },
    };
    await expect(runOp(ctxWith(keptSteps(), providers), { op: 'rotate', instanceId: i.id })).rejects.toThrow('try again');
    await E.DB.prepare(`UPDATE instances SET pending_op = 'rotate' WHERE id = ?`).bind(i.id).run(); // staff rotate again
    const steps = keptSteps(async () => void (await sendBeat(i.credential)));
    await expect(runOp(ctxWith(steps, providers, 2), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/did not report in/);
    // Two renewals since, and the instance's own credential is still the accepted old one.
    expect((await instanceRow(i.id))!.heartbeat_cred_hash_prev).toBe(await sha256Hex(i.credential));
  });

  it('a later rotation never revives an earlier one\'s expired credential, nor extends a grace', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'rotate' });
    const stub = fakeStubFetch();
    const providers = getProviders(E, stub.fetchImpl);
    await expect(runOp(ctxWith(keptSteps(), providers, 1), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/did not report in/);
    const first = sentSecrets(stub).heartbeatCredential as string;
    // The first rotation's grace for the original credential is over.
    await E.DB.prepare(`UPDATE instances SET heartbeat_cred_prev_until = ?, pending_op = 'rotate' WHERE id = ?`).bind(Date.now() - 1, i.id).run();
    stub.calls.length = 0;
    await expect(runOp(ctxWith(keptSteps(), providers, 1), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/did not report in/);
    // The previous credential is now the first rotation's, with a fresh grace; the original stays refused.
    const row = (await instanceRow(i.id))!;
    expect(row.heartbeat_cred_hash_prev).toBe(await sha256Hex(first));
    expect((await sendBeat(i.credential)).status).toBe(401);
    // A retry within the grace keeps the previous credential and its deadline as they are.
    const deadline = row.heartbeat_cred_prev_until;
    await E.DB.prepare(`UPDATE instances SET pending_op = 'rotate' WHERE id = ?`).bind(i.id).run();
    await expect(runOp(ctxWith(keptSteps(), providers, 1), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/did not report in/);
    expect(await instanceRow(i.id)).toMatchObject({ heartbeat_cred_hash_prev: await sha256Hex(first), heartbeat_cred_prev_until: deadline });
  });

  it('the tunnel not reconnecting fails the op', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'rotate' });
    const stub = fakeStubFetch();
    const base = getProviders(E, stub.fetchImpl);
    const providers: Providers = { ...base, edge: { ...base.edge, tunnelStatuses: async (ids) => Object.fromEntries(ids.map((t) => [t, 'down' as const])) } };
    const steps = keptSteps(async (name) => {
      if (name === 'new credential: wait') await sendBeat(sentSecrets(stub).heartbeatCredential);
    });
    await expect(runOp(ctxWith(steps, providers), { op: 'rotate', instanceId: i.id })).rejects.toThrow(/tunnel did not reconnect/);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, secrets_rotated_at: null });
  });

  it('an instance stopped or deleted meanwhile (claim gone) is left alone', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped', pending_op: null });
    const stub = fakeStubFetch();
    expect(await runOp(ctxWith(keptSteps(), getProviders(E, stub.fetchImpl)), { op: 'rotate', instanceId: i.id })).toEqual({ ok: false, outcome: 'aborted' });
    expect(stub.calls).toEqual([]);
  });
});

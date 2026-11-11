// Outbound network policy (D73): the org's policy and per-instance overrides through the routes
// (permissions, MFA only to loosen, compare-and-set, fan-out to the instances that follow the org,
// pending while asleep, audit), and the operations applying it on the worca service.
import { beforeEach, describe, expect, it } from 'vitest';
import { getInstance, stopForAbuse, type InstanceRow } from '../../../packages/platform/src/control/instances/api';
import { changeInstanceEgress, instanceEgress } from '../../../packages/platform/src/control/instances/egress-api';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import { getProviders, type Providers } from '../../../packages/platform/src/control/providers';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });
const mfaHeaders = (mfa: boolean): Record<string, string> => (mfa ? {} : { 'x-test-mfa': '0' });
const getOrg = (orgId: string, user: string) => app.call('GET', `/api/orgs/${orgId}/egress`, { user });
const putOrg = (orgId: string, user: string, body: unknown, mfa = true) => app.call('PUT', `/api/orgs/${orgId}/egress`, { user, body, headers: mfaHeaders(mfa) });
const getInst = (orgId: string, id: string, user: string) => app.call('GET', `/api/orgs/${orgId}/instances/${id}/egress`, { user });
const putInst = (orgId: string, id: string, user: string, body: unknown, mfa = true) =>
  app.call('PUT', `/api/orgs/${orgId}/instances/${id}/egress`, { user, body, headers: mfaHeaders(mfa) });

const BLOCK = { mode: 'block', deny: ['pastebin.com'] };
const ALLOW = { mode: 'allow', allow: ['*.github.com', 'registry.npmjs.org'], deny: ['gist.github.com'] };
const PLATFORM = ['app.localhost', '127.0.0.1', 'worca-platform-broker.railway.internal'];
const P = PLATFORM.join(',');

function opsCtx(stub: ReturnType<typeof fakeStubFetch>, onSleep?: (name: string) => Promise<void>, providers?: Providers): OpsContext {
  return { env: E, providers: providers ?? getProviders(E, stub.fetchImpl), steps: immediateSteps(onSleep), pollMs: 1, maxPolls: 3 };
}

/** Sets the org's policy straight through the route (MFA session) and returns the new version. */
async function setOrg(orgId: string, admin: string, policy: unknown, version = 0): Promise<number> {
  const res = await putOrg(orgId, admin, { policy, version });
  expect(res.status).toBe(200);
  return res.json.version;
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('GET /api/orgs/:orgId/egress', () => {
  it('open with empty lists until changed; the platform hosts; how many instances follow it', async () => {
    const o = await seedOrg();
    await seedInstance(o.orgId);
    await seedInstance(o.orgId, { status: 'suspended' });
    await seedInstance(o.orgId, { egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["x.com"]}' });
    await seedInstance(o.orgId, { status: 'deleting' });
    const res = await getOrg(o.orgId, o.admin);
    expect(res.status).toBe(200);
    expect(res.json.policy).toEqual({ mode: 'open', allow: [], deny: [] });
    expect(res.json.version).toBe(0);
    expect(res.json.platformHosts.map((p: { host: string }) => p.host)).toEqual(PLATFORM);
    expect(res.json.instances).toEqual({ inheriting: 2, inheritingRunning: 1, overriding: 1 });
    expect(res.json.overrides).toHaveLength(1);
    expect(res.json.overrides[0].mode).toBe('block');
  });

  it('tenant admins only', async () => {
    const o = await seedOrg();
    expect((await getOrg(o.orgId, o.user)).status).toBe(403);
    expect((await getOrg(o.orgId, crypto.randomUUID())).status).toBe(404); // not a member
  });
});

describe('PUT /api/orgs/:orgId/egress', () => {
  it('tightening needs no MFA session; stored encrypted, versioned, audited with from and to', async () => {
    const o = await seedOrg();
    const res = await putOrg(o.orgId, o.admin, { policy: BLOCK, version: 0 }, false);
    expect(res).toMatchObject({ status: 200, json: { ok: true, result: 'saved', version: 1, applying: 0, pending: 0, policy: { mode: 'block', allow: [], deny: ['pastebin.com'] } } });
    const row = await E.DB.prepare(`SELECT * FROM org_egress_policies WHERE org_id = ?`).bind(o.orgId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ mode: 'block', version: 1, hosts: 'enc:{"allow":[],"deny":["pastebin.com"]}' });
    expect(recorded.auditOrg).toEqual([
      {
        orgId: o.orgId, actorId: o.admin, actorScope: 'tenant', action: 'org.egress_updated', targetType: 'org', targetId: o.orgId,
        details: { from: { mode: 'open', allow: [], deny: [] }, to: { mode: 'block', allow: [], deny: ['pastebin.com'] }, applying: 0, pending: 0 },
      },
    ]);
    expect((await getOrg(o.orgId, o.admin)).json).toMatchObject({ policy: { mode: 'block', deny: ['pastebin.com'] }, version: 1 });
  });

  it('loosening needs an MFA session', async () => {
    const o = await seedOrg();
    let v = await setOrg(o.orgId, o.admin, ALLOW);
    // Adding an allow entry, removing a block entry, switching to block or open: each refused without MFA.
    for (const policy of [
      { ...ALLOW, allow: [...ALLOW.allow, 'pypi.org'] },
      { ...ALLOW, deny: [] },
      { mode: 'block', deny: ['x.com'] },
      { mode: 'open' },
    ]) {
      expect(await putOrg(o.orgId, o.admin, { policy, version: v }, false)).toMatchObject({ status: 403, json: { error: 'mfa_required' } });
    }
    expect((await getOrg(o.orgId, o.admin)).json.version).toBe(v);
    // Tightening the allowlist and adding a block entry: no MFA needed.
    const tighter = await putOrg(o.orgId, o.admin, { policy: { mode: 'allow', allow: ['registry.npmjs.org'], deny: ['gist.github.com', 'evil.com'] }, version: v }, false);
    expect(tighter.status).toBe(200);
    v = tighter.json.version;
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'open' }, version: v }, true)).toMatchObject({ status: 200, json: { result: 'saved' } });
  });

  it('compare-and-set on the version the change was based on: 409 egress_changed', async () => {
    const o = await seedOrg();
    await setOrg(o.orgId, o.admin, BLOCK);
    // Based on version 0 (a stale page): refused, even a tightening, and nothing changes.
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['pastebin.com', 'b.com'] }, version: 0 })).toMatchObject({
      status: 409, json: { error: 'egress_changed' },
    });
    expect(await putOrg(o.orgId, o.admin, { policy: BLOCK, version: 7 })).toMatchObject({ status: 409, json: { error: 'egress_changed' } });
    expect((await getOrg(o.orgId, o.admin)).json).toMatchObject({ version: 1, policy: { deny: ['pastebin.com'] } });
  });

  it('the same policy changes nothing: no version, no audit', async () => {
    const o = await seedOrg();
    const v = await setOrg(o.orgId, o.admin, BLOCK);
    recorded.auditOrg.length = 0;
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['PASTEBIN.com.'] }, version: v }, false)).toMatchObject({
      status: 200, json: { result: 'unchanged', version: v },
    });
    expect(recorded.auditOrg).toEqual([]);
  });

  it('refusals name the list and the entry, for the field error', async () => {
    const o = await seedOrg();
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'allow', allow: ['ok.com', 'https://bad.com'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_host_invalid', field: 'allow', entry: 'https://bad.com', reason: 'scheme' },
    });
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['*'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_host_invalid', field: 'deny', entry: '*', reason: 'wildcard' },
    });
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['*.localhost'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_host_invalid', reason: 'no_dot' },
    });
    // The local platform host (app.localhost) can't be blocked.
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['app.localhost'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_blocks_platform_host', field: 'deny', entry: 'app.localhost' },
    });
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'block', deny: ['*.railway.internal'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_blocks_platform_host', entry: '*.railway.internal' },
    });
    const many = Array.from({ length: 201 }, (_, i) => `h${i}.example.com`);
    expect(await putOrg(o.orgId, o.admin, { policy: { mode: 'allow', allow: many }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_too_many', field: 'allow' },
    });
    for (const body of [{}, { policy: { mode: 'closed' }, version: 0 }, { policy: BLOCK }, { policy: BLOCK, version: -1 }, { policy: { ...BLOCK, extra: 1 }, version: 0 }, null]) {
      expect((await putOrg(o.orgId, o.admin, body)).json).toEqual({ error: 'invalid_body' });
    }
    expect(recorded.auditOrg).toEqual([]);
  });

  it('tenant admins only', async () => {
    const o = await seedOrg();
    expect((await putOrg(o.orgId, o.user, { policy: BLOCK, version: 0 })).status).toBe(403);
    expect((await putOrg(o.orgId, o.outsider, { policy: BLOCK, version: 0 })).status).toBe(403);
    expect((await putOrg(o.orgId, crypto.randomUUID(), { policy: BLOCK, version: 0 })).status).toBe(404);
  });

  it('fans out to the instances that follow the org: running ones restart, the others get it on their next start; overrides untouched', async () => {
    const o = await seedOrg();
    const running = await seedInstance(o.orgId);
    const asleep = await seedInstance(o.orgId, { status: 'suspended' });
    const stopped = await seedInstance(o.orgId, { status: 'stopped', stopped_reason: 'x' });
    const busy = await seedInstance(o.orgId, { pending_op: 'suspend' });
    const upgrading = await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0' });
    const creating = await seedInstance(o.orgId, { status: 'creating' });
    const deleting = await seedInstance(o.orgId, { status: 'deleting' });
    const own = await seedInstance(o.orgId, { egress_mode: 'open' });
    const other = await seedOrg();
    const elsewhere = await seedInstance(other.orgId);

    const res = await putOrg(o.orgId, o.admin, { policy: BLOCK, version: 0 }, false);
    expect(res.json).toMatchObject({ result: 'saved', applying: 1, applyingIds: [running.id], pending: 5 });
    expect(recorded.ops).toEqual([{ op: 'reconfigure', instanceId: running.id, actorId: o.admin }]);
    expect(await instanceRow(running.id)).toMatchObject({ pending_op: 'reconfigure', egress_pending: 1, egress_version: 1 });
    for (const i of [asleep, stopped, upgrading, creating]) expect(await instanceRow(i.id)).toMatchObject({ egress_pending: 1, egress_version: 1 });
    expect(await instanceRow(busy.id)).toMatchObject({ pending_op: 'suspend', egress_pending: 1 });
    expect(await instanceRow(asleep.id)).toMatchObject({ pending_op: null });
    for (const i of [deleting, own, elsewhere]) expect(await instanceRow(i.id)).toMatchObject({ egress_pending: 0, egress_version: 0, pending_op: null });
    expect(recorded.auditOrg.at(-1)!.details).toMatchObject({ applying: 1, pending: 5 });
  });

  it('an instance whose reconfigure is already under way is marked, not claimed again (its op applies it in another round)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { pending_op: 'reconfigure', remote_pending: 1, terminal_remote: 1 });
    await setOrg(o.orgId, o.admin, BLOCK);
    expect(recorded.ops).toEqual([]);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: 'reconfigure', egress_pending: 1 });
  });

  it('a refused change (stale version) marks no instance', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    await setOrg(o.orgId, o.admin, BLOCK);
    expect((await putOrg(o.orgId, o.admin, { policy: ALLOW, version: 0 })).status).toBe(409);
    expect(await instanceRow(i.id)).toMatchObject({ egress_version: 1 });
  });
});

describe('GET /api/orgs/:orgId/instances/:id/egress', () => {
  it('everyone who can see the instance reads the effective policy and where it comes from', async () => {
    const o = await seedOrg();
    const inst = await seedInstance(o.orgId);
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(inst.id, o.teamA).run();
    await setOrg(o.orgId, o.admin, BLOCK);
    for (const user of [o.admin, o.user]) {
      const res = await getInst(o.orgId, inst.id, user);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        effective: { mode: 'block', allow: [], deny: ['pastebin.com'] }, inherited: true, override: null,
        org: { policy: { mode: 'block' }, version: 1 }, version: 1, pending: true,
      });
      expect(res.json.platformHosts.map((p: { host: string }) => p.host)).toEqual(PLATFORM);
    }
    // Not in a team that grants it: not found, as the instance itself.
    expect((await getInst(o.orgId, inst.id, o.outsider)).status).toBe(404);
    expect((await getInst(o.orgId, inst.id, crypto.randomUUID())).status).toBe(404);
  });

  it('an override is the effective policy', async () => {
    const o = await seedOrg();
    const inst = await seedInstance(o.orgId, { egress_mode: 'allow', egress_hosts: 'enc:{"allow":["a.com"],"deny":[]}', egress_version: 3 });
    const res = await getInst(o.orgId, inst.id, o.admin);
    expect(res.json).toMatchObject({ effective: { mode: 'allow', allow: ['a.com'], deny: [] }, inherited: false, override: { mode: 'allow' }, version: 3, pending: false });
  });
});

describe('PUT /api/orgs/:orgId/instances/:id/egress', () => {
  it('an override on a running instance: stored encrypted, pending, reconfigure started, audited', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const res = await putInst(o.orgId, i.id, o.admin, { policy: ALLOW, version: 0 });
    expect(res).toMatchObject({ status: 200, json: { ok: true, result: 'applying' } });
    expect(await instanceRow(i.id)).toMatchObject({
      egress_mode: 'allow', egress_hosts: 'enc:{"allow":["*.github.com","registry.npmjs.org"],"deny":["gist.github.com"]}', egress_version: 1,
      egress_pending: 1, pending_op: 'reconfigure',
    });
    expect(recorded.ops).toEqual([{ op: 'reconfigure', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toEqual([
      {
        orgId: o.orgId, actorId: o.admin, actorScope: 'tenant', action: 'instance.egress_set', targetType: 'instance', targetId: i.id,
        details: { from: null, to: { mode: 'allow', allow: ['*.github.com', 'registry.npmjs.org'], deny: ['gist.github.com'] } },
      },
    ]);
  });

  it('MFA only when the effective policy loosens, including removing an override stricter than the org', async () => {
    const o = await seedOrg();
    // Org open; a block override is a tightening.
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: BLOCK, version: 0 }, false)).toMatchObject({ status: 200, json: { result: 'saved' } });
    // Back to the org's (open): loosening.
    expect(await putInst(o.orgId, i.id, o.admin, { policy: null, version: 1 }, false)).toMatchObject({ status: 403, json: { error: 'mfa_required' } });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: null, version: 1 }, true)).toMatchObject({ status: 200, json: { result: 'saved' } });
    expect(await instanceRow(i.id)).toMatchObject({ egress_mode: null, egress_hosts: null, egress_version: 2, egress_pending: 1 });
    expect(recorded.auditOrg.at(-1)).toMatchObject({ action: 'instance.egress_reset', details: { from: { mode: 'block' }, to: null, appliesOnStart: true } });

    // Org strict (allow); an override that opens up needs MFA; removing it again does not.
    await setOrg(o.orgId, o.admin, ALLOW);
    const j = await seedInstance(o.orgId, { status: 'stopped', stopped_reason: 'x' });
    expect(await putInst(o.orgId, j.id, o.admin, { policy: { mode: 'open' }, version: 0 }, false)).toMatchObject({ status: 403 });
    expect(await putInst(o.orgId, j.id, o.admin, { policy: { mode: 'open' }, version: 0 }, true)).toMatchObject({ status: 200 });
    expect(await putInst(o.orgId, j.id, o.admin, { policy: null, version: 1 }, false)).toMatchObject({ status: 200, json: { result: 'saved' } });
  });

  it('an override equal to the org policy (and removing it) is stored without restarting Worca', async () => {
    const o = await seedOrg();
    await setOrg(o.orgId, o.admin, BLOCK);
    const i = await seedInstance(o.orgId, { egress_version: 1 });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: BLOCK, version: 1 }, false)).toMatchObject({ status: 200, json: { result: 'stored' } });
    expect(await instanceRow(i.id)).toMatchObject({ egress_mode: 'block', egress_version: 2, egress_pending: 0, pending_op: null });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: null, version: 2 }, false)).toMatchObject({ status: 200, json: { result: 'stored' } });
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg.map((a) => a.action).slice(-2)).toEqual(['instance.egress_set', 'instance.egress_reset']);
  });

  it('the same override changes nothing; still pending on a running instance it is applied again', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["pastebin.com"]}', egress_version: 4 });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: BLOCK, version: 4 })).toMatchObject({ status: 200, json: { result: 'unchanged' } });
    expect(recorded.ops).toEqual([]);
    // Following the org, with a change that wasn't applied (the instance was busy): "apply now".
    const missed = await seedInstance(o.orgId, { egress_pending: 1, egress_version: 2 });
    expect(await putInst(o.orgId, missed.id, o.admin, { policy: null, version: 2 }, false)).toMatchObject({ status: 200, json: { result: 'applying' } });
    expect(recorded.ops.map((p) => p.instanceId)).toEqual([missed.id]);
    expect(recorded.auditOrg).toEqual([]);
  });

  it('compare-and-set: on the instance version, and on the org policy it was decided against', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["pastebin.com"]}', egress_version: 1 });
    expect(await putInst(o.orgId, i.id, o.admin, { policy: ALLOW, version: 0 })).toMatchObject({ status: 409, json: { error: 'egress_changed' } });
    expect(await instanceRow(i.id)).toMatchObject({ egress_mode: 'block', egress_version: 1 });

    // Removing the override was decided (no MFA: the org was stricter) against an org policy that
    // changed before the write (an overriding instance's version doesn't move): refused.
    await setOrg(o.orgId, o.admin, ALLOW);
    const row = (await getInstance(E, i.id)) as InstanceRow;
    const cur = await instanceEgress(E, row);
    await setOrg(o.orgId, o.admin, { mode: 'open' }, 1);
    await expect(changeInstanceEgress(E, row, cur, null, o.admin)).rejects.toMatchObject({ status: 409, message: 'egress_changed' });
    expect(await instanceRow(i.id)).toMatchObject({ egress_mode: 'block', egress_version: 1 });
  });

  it('refuses while another operation is under way (409 instance_busy)', async () => {
    const o = await seedOrg();
    for (const fields of [
      { status: 'upgrading', target_version: '1.9.0' }, { status: 'creating' }, { pending_op: 'suspend' }, { pending_op: 'reconfigure' },
      { status: 'suspended', pending_op: 'wake' }, { status: 'deleting' },
    ]) {
      const i = await seedInstance(o.orgId, fields);
      expect(await putInst(o.orgId, i.id, o.admin, { policy: BLOCK, version: 0 })).toMatchObject({ status: 409, json: { error: 'instance_busy' } });
      expect(await instanceRow(i.id)).toMatchObject({ egress_mode: null, egress_version: 0 });
    }
    expect(recorded.ops).toEqual([]);
    expect(recorded.auditOrg).toEqual([]);
  });

  it('validates, and only tenant admins of the org change it', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect(await putInst(o.orgId, i.id, o.admin, { policy: { mode: 'block', deny: ['bad host.com'] }, version: 0 })).toMatchObject({
      status: 400, json: { error: 'egress_host_invalid', field: 'deny', entry: 'bad host.com', reason: 'chars' },
    });
    expect((await putInst(o.orgId, i.id, o.admin, { version: 0 })).json).toEqual({ error: 'invalid_body' });
    expect((await putInst(o.orgId, i.id, o.user, { policy: BLOCK, version: 0 })).status).toBe(403);
    expect((await putInst(o.orgId, crypto.randomUUID(), o.admin, { policy: BLOCK, version: 0 })).status).toBe(404);
    const other = await seedOrg();
    expect((await putInst(other.orgId, i.id, other.admin, { policy: BLOCK, version: 0 })).status).toBe(404);
    expect(await instanceRow(i.id)).toMatchObject({ egress_mode: null });
  });
});

describe('applying it on the worca service', () => {
  it('reconfigure sets the rendered policy on the worca service only, restarts worca, clears pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, {
      egress_mode: 'allow', egress_hosts: 'enc:{"allow":["*.github.com"],"deny":["gist.github.com"]}', egress_version: 1, egress_pending: 1, pending_op: 'reconfigure',
    });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect(stub.calls.map((c) => `${c.method} ${c.path.split('/').at(-1)}`)).toEqual(['POST variables', 'POST deploy', `GET ${i.id}`]);
    expect(stub.calls[0]!.body.variables).toEqual({
      terminalRemote: false, actionsRemote: false,
      egress: { mode: 'allow', allow: `${P},.github.com`, deny: 'gist.github.com' },
      size: { cpu: 2, memoryMb: 4096, maxParallel: 4, maxParallelScripts: 2 },
      ghAsPerson: 'prefer', // D79: members' own GitHub by default
    });
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, egress_pending: 0 });
  });

  it('an org change while worca restarts is applied in another round', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { egress_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    const p = getProviders(E, stub.fetchImpl);
    let changed = false;
    const providers: Providers = {
      ...p,
      compute: {
        ...p.compute,
        restartWorca: async (ref) => {
          if (!changed) {
            changed = true;
            await setOrg(o.orgId, o.admin, BLOCK); // marks the instance pending again, doesn't claim it
          }
          return p.compute.restartWorca(ref);
        },
      },
    };
    const ctx = opsCtx(stub, undefined, providers);
    expect(await runOp(ctx, { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect((ctx.steps as ReturnType<typeof immediateSteps>).names).toEqual([
      'load', 'set worca settings', 'restart worca', 'confirm restart: check', 'mark applied',
      'set worca settings (2)', 'restart worca (2)', 'confirm restart: check (2)', 'mark applied (2)', 'compute facts',
    ]);
    const sets = stub.calls.filter((c) => c.path.endsWith('/variables')).map((c) => c.body.variables.egress);
    expect(sets).toEqual([{ mode: 'open', allow: P, deny: '.invalid' }, { mode: 'block', allow: P, deny: 'pastebin.com' }]);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, egress_pending: 0, egress_version: 1 });
  });

  it('a stop for abuse during the restart still wins; the policy stays pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { egress_mode: 'open', egress_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    const p = getProviders(E, stub.fetchImpl);
    const providers: Providers = {
      ...p,
      compute: { ...p.compute, restartWorca: async (ref) => (await stopForAbuse(E, i.id, { actorId: 'staff', reason: 'mining' }), p.compute.restartWorca(ref)) },
    };
    expect(await runOp(opsCtx(stub, undefined, providers), { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: false, outcome: 'stopped_meanwhile' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'deploy', 'stop']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'stopped', egress_pending: 1 });
  });

  it('a new worca deployment that fails, or never runs, fails the op: the claim goes, the policy stays pending', async () => {
    const o = await seedOrg();
    for (const [state, error] of [['failed', /deployment failed/], ['starting', /did not start in time/]] as const) {
      const i = await seedInstance(o.orgId, { egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["x.com"]}', egress_pending: 1, pending_op: 'reconfigure' });
      const stub = fakeStubFetch();
      const p = getProviders(E, stub.fetchImpl);
      const providers: Providers = { ...p, compute: { ...p.compute, worcaDeploymentState: async () => state } };
      await expect(runOp(opsCtx(stub, undefined, providers), { op: 'reconfigure', instanceId: i.id })).rejects.toThrow(error);
      expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: null, egress_pending: 1 });
    }
  });

  it('settings the provider could not confirm fail the op before any restart; the policy stays pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["x.com"]}', egress_pending: 1, pending_op: 'reconfigure' });
    const stub = fakeStubFetch();
    const p = getProviders(E, stub.fetchImpl);
    const providers: Providers = {
      ...p,
      compute: { ...p.compute, setWorcaSettings: async () => { throw new Error('railway setWorcaSettings: not confirmed on the worca service: WORCA_EGRESS_MODE'); } },
    };
    await expect(runOp(opsCtx(stub, undefined, providers), { op: 'reconfigure', instanceId: i.id })).rejects.toThrow(/not confirmed/);
    expect(stub.calls.filter((c) => c.path.endsWith('/deploy'))).toEqual([]);
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, egress_pending: 1 });
  });

  it('a wake that never hears from worca leaves the policy pending', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', egress_mode: 'open', egress_pending: 1 });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub), { op: 'wake', instanceId: i.id })).toEqual({ ok: false, outcome: 'wake_timeout' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'start']);
    expect(await instanceRow(i.id)).toMatchObject({ egress_pending: 1 });
  });

  it('a wake applies a pending policy before starting; a lift too', async () => {
    const o = await seedOrg();
    await setOrg(o.orgId, o.admin, BLOCK);
    for (const [status, op] of [['suspended', 'wake'], ['stopped', 'lift']] as const) {
      const i = await seedInstance(o.orgId, { status, pending_op: op, egress_pending: 1, egress_version: 1, stopped_reason: status === 'stopped' ? 'x' : null });
      const stub = fakeStubFetch();
      expect(await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential))), { op, instanceId: i.id })).toEqual({ ok: true, outcome: 'running' });
      expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'start']);
      expect(stub.calls[0]!.body.variables.egress).toEqual({ mode: 'block', allow: P, deny: 'pastebin.com' });
      expect(await instanceRow(i.id)).toMatchObject({ status: 'running', egress_pending: 0 });
    }
  });

  it('an upgrade applies a pending policy before the deploy', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_released_versions', '["1.9.0","1.9.2"]', 0)`).run();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.0', target_version: '1.9.2', egress_mode: 'block', egress_hosts: 'enc:{"allow":[],"deny":["*.ngrok.io"]}', egress_pending: 1 });
    const stub = fakeStubFetch();
    const r = await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential, beat({ version: '1.9.2' })))), { op: 'upgrade', instanceId: i.id });
    expect(r).toEqual({ ok: true, outcome: 'upgraded' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'deploy']);
    expect(stub.calls[0]!.body.variables.egress).toEqual({ mode: 'block', allow: P, deny: '.ngrok.io' });
    expect((await getInstance(E, i.id))!.egress_pending).toBe(0);
  });

  it("a new instance is created with the org's policy", async () => {
    const o = await seedOrg();
    await setOrg(o.orgId, o.admin, ALLOW);
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });
    await runOp(ctx, { op: 'create', instanceId: created.json.id });
    const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
    expect(vars.egress).toEqual({ mode: 'allow', allow: `${P},.github.com,registry.npmjs.org`, deny: 'gist.github.com' });
    expect(vars).not.toHaveProperty('egressAllowlist');
    expect(await instanceRow(created.json.id)).toMatchObject({ egress_mode: null, egress_pending: 0 });
  });

  it('an org change during the create, after its variables were set, stays pending', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const stub = fakeStubFetch();
    const p = getProviders(E, stub.fetchImpl);
    const providers: Providers = {
      ...p,
      compute: { ...p.compute, deploy: async (ref, image) => (await setOrg(o.orgId, o.admin, BLOCK), p.compute.deploy(ref, image)) },
    };
    const ctx = opsCtx(stub, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    }, providers);
    await runOp(ctx, { op: 'create', instanceId: created.json.id });
    expect(stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables.egress).toEqual({ mode: 'open', allow: P, deny: '.invalid' });
    expect(await instanceRow(created.json.id)).toMatchObject({ status: 'running', egress_pending: 1, egress_version: 1 });
  });
});

// Gate object alarms (D27 idle suspend, D56 schedule wake), state, destroy, and GateRpc.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateRpcApi } from '../../../packages/platform/src/shared/contracts';
import { control, env, newInstance, now, stub, type Instance } from './helpers';

let inst: Instance;
beforeEach(async () => {
  inst = await newInstance();
});

/** Pretends the last visit and status change were `ago` seconds back. */
async function ageBy(i: Instance, ago: number): Promise<void> {
  await runInDurableObject(stub(i), (o) => {
    const meta = (o as unknown as { meta: { lastVisit: number | null; statusAt: number | null } }).meta;
    meta.lastVisit = Date.now() - ago * 1000;
    meta.statusAt = Date.now() - ago * 1000;
  });
}
const callsNamed = async (name: string) => (await control.calls()).filter((c) => c[0] === name);

describe('idle alarm (D27)', () => {
  it('is set a day after the last status change or visit', async () => {
    const { alarmAt } = await stub(inst).getState();
    expect(alarmAt! - Date.now()).toBeGreaterThan(86_399_000);
    expect(alarmAt! - Date.now()).toBeLessThanOrEqual(86_400_000);
  });

  it('idle and suspendable: asks the control plane to suspend', async () => {
    await stub(inst).heartbeat(inst.instanceId, { suspendable: true, nextScheduledAt: null });
    await ageBy(inst, 86_401);
    expect(await runDurableObjectAlarm(stub(inst))).toBe(true);
    expect(await callsNamed('requestSuspend')).toEqual([['requestSuspend', inst.instanceId]]);
  });

  it('idle but not suspendable: no suspend, tries again an hour later', async () => {
    await stub(inst).heartbeat(inst.instanceId, { suspendable: false, nextScheduledAt: null });
    await ageBy(inst, 86_401);
    await runDurableObjectAlarm(stub(inst));
    expect(await callsNamed('requestSuspend')).toEqual([]);
    const { alarmAt } = await stub(inst).getState();
    expect(Math.abs(alarmAt! - (Date.now() + 3_600_000))).toBeLessThan(5_000);
  });

  it('visited since: no suspend, alarm moved to a day after the visit', async () => {
    await stub(inst).heartbeat(inst.instanceId, { suspendable: true, nextScheduledAt: null });
    await ageBy(inst, 3_600);
    await runDurableObjectAlarm(stub(inst));
    expect(await callsNamed('requestSuspend')).toEqual([]);
    const { alarmAt } = await stub(inst).getState();
    expect(Math.abs(alarmAt! - (Date.now() + (86_400 - 3_600) * 1000))).toBeLessThan(5_000);
  });

  it('no idle alarm while stopped', async () => {
    await stub(inst).setStatus(inst.instanceId, 'stopped');
    expect((await stub(inst).getState()).alarmAt).toBeNull();
  });
});

describe('schedule wake (D56)', () => {
  it('suspended with a scheduled run: alarm 10 minutes before it', async () => {
    const next = now() + 7_200;
    await stub(inst).heartbeat(inst.instanceId, { suspendable: true, nextScheduledAt: next });
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    expect((await stub(inst).getState()).alarmAt).toBe((next - 600) * 1000);
  });

  it('the alarm wakes the instance once', async () => {
    await stub(inst).heartbeat(inst.instanceId, { suspendable: true, nextScheduledAt: now() + 300 });
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    // The wake time is already past, so the runtime may fire the alarm before we force it.
    await runDurableObjectAlarm(stub(inst));
    await vi.waitFor(async () => expect(await callsNamed('requestWake')).toHaveLength(1));
    expect(await callsNamed('requestWake')).toEqual([['requestWake', inst.instanceId, 'schedule']]);
    const state = await stub(inst).getState();
    expect(state.waking).toBe(true);
    expect(state.alarmAt).toBeNull();
    expect(await stub(inst).startWake(inst.instanceId, 'visit')).toBe(false); // deduped
  });

  it('suspended without a scheduled run: no alarm', async () => {
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    expect((await stub(inst).getState()).alarmAt).toBeNull();
  });
});

describe('state', () => {
  it('reports sessions, status and visits; destroy wipes everything', async () => {
    const s = stub(inst);
    await s.createSession(inst.instanceId, 'u1', 'c1');
    await s.heartbeat(inst.instanceId, { suspendable: true, nextScheduledAt: 123 });
    const state = await s.getState();
    expect(state).toMatchObject({ instanceId: inst.instanceId, status: 'running', sessions: 1, suspendable: true, nextScheduledAt: 123, waking: false });
    expect(state.lastVisit).toBeGreaterThan(0);
    await s.destroy();
    expect(await s.getState()).toMatchObject({ status: 'unknown', sessions: 0, lastVisit: null, alarmAt: null });
  });

  it('a conditional status change never overrides a stop that raced it', async () => {
    const s = stub(inst);
    await s.setStatus(inst.instanceId, 'stopped');
    await s.setStatus(inst.instanceId, 'running', ['creating']); // a late heartbeat's repair
    expect((await s.getState()).status).toBe('stopped');
    await s.setStatus(inst.instanceId, 'creating');
    await s.setStatus(inst.instanceId, 'running', ['creating']);
    expect((await s.getState()).status).toBe('running');
  });

  it('a wake is never started unless suspended', async () => {
    expect(await stub(inst).startWake(inst.instanceId, 'visit')).toBe(false);
    expect(await callsNamed('requestWake')).toEqual([]);
  });
});

describe('GateRpc', () => {
  const rpc = () => (exports as unknown as { GateRpc: GateRpcApi }).GateRpc;

  it('putHost / deleteHost write KV', async () => {
    await rpc().putHost('zz.run.localhost', { instanceId: 'i-zz', kind: 'keypage' });
    expect(await env.HOSTS.get('zz.run.localhost', 'json')).toEqual({ instanceId: 'i-zz', kind: 'keypage' });
    await rpc().deleteHost('zz.run.localhost');
    expect(await env.HOSTS.get('zz.run.localhost')).toBeNull();
  });

  it('forwards to the instance gate object', async () => {
    await stub(inst).createSession(inst.instanceId, 'u1', 'c1');
    await rpc().setStatus(inst.instanceId, 'upgrading');
    await rpc().heartbeat(inst.instanceId, { suspendable: false, nextScheduledAt: null });
    expect(await rpc().getState(inst.instanceId)).toMatchObject({ instanceId: inst.instanceId, status: 'upgrading', sessions: 1, suspendable: false });
    expect(await rpc().dropSessions(inst.instanceId, { userId: 'u1' })).toBe(1);
    await rpc().destroy(inst.instanceId);
    expect((await rpc().getState(inst.instanceId)).status).toBe('unknown');
  });
});

// (g) Idle suspend and wake (D27, D47, D48, D56; instance-lifecycle.md "Suspend and wake").
// Needs E2E_FAST=1 for both `npm run dev` and the tests: IDLE_SECONDS=20, RECHECK_SECONDS=10,
// SCHEDULE_WAKE_LEAD_SECONDS=30.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, IDLE_SECONDS, GATE_PORT } from './lib/config.mjs';
import {
  eventually, expectStatus, getInstance, instanceFetch, instanceFixture, setStubReport, signInToInstance, sleep, stubAdmin, stubInstance, waitForStatus,
} from './lib/flows.mjs';

const skip = await skipUnlessUp({ needFast: true });
const RECHECK_SECONDS = Number(process.env.E2E_RECHECK_SECONDS || 10);
const WAKE_LEAD_SECONDS = Number(process.env.E2E_WAKE_LEAD_SECONDS || 30);
const SUSPEND_TIMEOUT = (IDLE_SECONDS + RECHECK_SECONDS + 60) * 1000;

describe('idle suspend and wake', { skip }, () => {
  let fx;
  before(async () => {
    fx = await instanceFixture('idle');
  });

  it('is not suspended while the heartbeat says it is busy', async () => {
    const { admin, orgId, inst, member } = fx;
    await setStubReport(inst.id, { suspendable: false, pipelines: { running: 1 } });
    await signInToInstance(member, inst.host); // a visit: the idle clock starts now
    await sleep((IDLE_SECONDS + RECHECK_SECONDS / 2) * 1000);
    assert.equal((await getInstance(admin, orgId, inst.id)).status, 'running');
    assert.equal((await stubInstance(inst.id)).state, 'running');
  });

  it('suspends once idle and suspendable; the next visit shows "starting" and wakes it', async () => {
    const { admin, orgId, inst, member } = fx;
    await setStubReport(inst.id, { suspendable: true, pipelines: {} });
    await waitForStatus(admin, orgId, inst.id, 'suspended', SUSPEND_TIMEOUT);
    await eventually(async () => (await stubInstance(inst.id))?.state === 'stopped', { what: 'services stopped (D48)' });
    const beatsWhileSuspended = (await stubInstance(inst.id)).beats;

    const page = await member.browser.fetch(`http://${inst.host}:${GATE_PORT}/`, { navigate: true });
    assert.equal(page.status, 503, page.describe());
    assert.match(page.text, /starting/i);
    assert.match(page.text, /\/\.gate\/status/, 'the page polls the gate status');
    const api = await instanceFetch(member, inst.host, '/api/x');
    assert.equal(api.status, 503);
    assert.equal(api.json().error, 'instance_starting');

    await eventually(async () => {
      const s = await instanceFetch(member, inst.host, '/.gate/status');
      return s.status === 200 && s.json().status === 'running';
    }, { timeoutMs: 60_000, what: '/.gate/status running' });
    // The status flips while the waking heartbeat is answered; the stub counts it just after.
    await eventually(async () => {
      const st = await stubInstance(inst.id);
      return st.state === 'running' && st.beats > beatsWhileSuspended;
    }, { timeoutMs: 10_000, what: 'stub running and heartbeating again' });
    assert.equal((await getInstance(admin, orgId, inst.id)).status, 'running');
    const echo = await instanceFetch(member, inst.host, '/after-wake');
    assert.equal(echo.status, 200, echo.describe());
  });

  it('a scheduled run wakes a suspended instance shortly before it (D56)', async () => {
    const { admin, orgId, inst } = fx;
    const nowS = Math.floor(Date.now() / 1000);
    const nextScheduledAt = nowS + IDLE_SECONDS + RECHECK_SECONDS + WAKE_LEAD_SECONDS + 30;
    await setStubReport(inst.id, { suspendable: true, pipelines: {}, nextScheduledAt });
    expectStatus(await stubAdmin('POST', `/${inst.id}/heartbeat`), 200, 'beat now'); // the gate object learns the schedule
    await waitForStatus(admin, orgId, inst.id, 'suspended', SUSPEND_TIMEOUT);
    const woke = await waitForStatus(admin, orgId, inst.id, 'running', (nextScheduledAt - Math.floor(Date.now() / 1000) + 60) * 1000);
    assert.ok(Date.now() / 1000 < nextScheduledAt, `woke before the scheduled run (${woke.status})`);
    await setStubReport(inst.id, { nextScheduledAt: null });
  });
});

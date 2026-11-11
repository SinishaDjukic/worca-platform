// (h) WebSockets through the gate, closed when the identity token used at the upgrade expires (W7,
// D46). The stub plays worca's part; its clock is moved forward per instance instead of waiting
// five minutes (set E2E_SLOW=1 to also wait for the real expiry).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, GATE_PORT } from './lib/config.mjs';
import { openWebSocket } from './lib/ws.mjs';
import { createTeam, expectStatus, instanceFixture, signInToInstance, stubAdmin } from './lib/flows.mjs';

const skip = await skipUnlessUp();

describe('WebSockets through the gate', { skip }, () => {
  let fx;
  before(async () => {
    fx = await instanceFixture('ws');
    await signInToInstance(fx.member, fx.inst.host);
  });
  after(async () => {
    if (fx) await stubAdmin('POST', `/${fx.inst.id}/clock`, { offsetSeconds: 0 });
  });

  const open = () => openWebSocket(`ws://${fx.inst.host}:${GATE_PORT}/ws`, { browser: fx.member.browser });

  it('upgrades same-origin, echoes, and carries the identity token', async () => {
    const res = await open();
    assert.ok(res.ok, `upgrade refused: ${res.status} ${res.body}`);
    const hello = JSON.parse(await res.ws.next());
    assert.equal(hello.type, 'hello');
    assert.equal(hello.host, fx.inst.host);
    assert.equal(hello.sub, fx.member.id);
    const nowS = Date.now() / 1000;
    assert.ok(hello.exp > nowS && hello.exp - nowS <= 600, `token expiry within minutes: ${hello.exp}`);
    res.ws.send('hello through the gate');
    assert.equal(await res.ws.next(), 'hello through the gate');
    res.ws.close();
  });

  it('is closed by the instance when the token used at the upgrade expires (W7)', async () => {
    const res = await open();
    assert.ok(res.ok, `upgrade refused: ${res.status}`);
    const hello = JSON.parse(await res.ws.next());
    const offset = hello.exp - Math.floor(Date.now() / 1000) - 2; // two seconds before expiry
    expectStatus(await stubAdmin('POST', `/${fx.inst.id}/clock`, { offsetSeconds: offset }), 200, 'shift stub clock');
    try {
      res.ws.send('still open');
      assert.equal(await res.ws.next(), 'still open');
      const closed = await res.ws.waitClose(10_000);
      assert.ok(closed, 'closed');
      assert.equal(closed.code, 4001, `close code: ${closed.code} ${closed.reason}`);
    } finally {
      await stubAdmin('POST', `/${fx.inst.id}/clock`, { offsetSeconds: 0 });
    }
    // worca reconnects; the reconnect is a fresh upgrade the gate checks (and counts as a visit).
    const again = await open();
    assert.ok(again.ok, `reconnect: ${again.status}`);
    again.ws.close();
  });

  it('really closes at the token expiry', { skip: process.env.E2E_SLOW === '1' ? false : 'set E2E_SLOW=1 (waits up to 5 minutes)' }, async () => {
    const res = await open();
    assert.ok(res.ok);
    const hello = JSON.parse(await res.ws.next());
    const closed = await res.ws.waitClose((hello.exp - Date.now() / 1000 + 10) * 1000);
    assert.ok(closed, 'closed');
    assert.ok(Math.abs(closed.at / 1000 - hello.exp) < 5, 'at the expiry');
  });

  it('a session without access cannot upgrade', async () => {
    const { admin, orgId, teamId, inst } = fx;
    // An instance keeps at least one team (D71): move it to a team the member isn't in.
    const elsewhere = await createTeam(admin, orgId, 'ws elsewhere');
    expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/teams`, { teamIds: [elsewhere] }), 200);
    try {
      const res = await open();
      assert.equal(res.ok, false, 'refused after the team was unassigned');
      assert.equal(res.status, 401);
    } finally {
      expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/teams`, { teamIds: [teamId] }), 200);
    }
  });
});

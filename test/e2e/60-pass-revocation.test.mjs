// (f) The 60-second pass and revocation (D44, D46; architecture.md "Revoking access").
// Run with E2E_FAST=1 (pass of 5 s) for the expiry checks; with the default 60 s pass they wait a
// minute each, so they only run when E2E_SLOW=1.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, FAST, GATE_PORT, PASS_SECONDS } from './lib/config.mjs';
import { openWebSocket } from './lib/ws.mjs';
import {
  Person, addToTeam, createTeam, expectStatus, gateState, inviteAndJoin, instanceFetch, instanceFixture, removeFromTeam, signInToInstance, sleep,
} from './lib/flows.mjs';

const skip = await skipUnlessUp();
const waitForExpiry = FAST || process.env.E2E_SLOW === '1';
const expirySkip = waitForExpiry ? false : `pass is ${PASS_SECONDS} s; set E2E_FAST=1 (stack and tests) or E2E_SLOW=1`;

describe('pass and revocation', { skip }, () => {
  let fx;
  before(async () => {
    fx = await instanceFixture('rv');
  });

  it('GETs within the pass do not ask the gate object; unsafe requests always do', async (t) => {
    const { member, inst } = fx;
    await signInToInstance(member, inst.host);
    // A POST asks the gate object (recording a visit) and re-issues the pass.
    expectStatus(await instanceFetch(member, inst.host, '/refresh', { method: 'POST', body: {} }), 200);
    const s1 = await gateState(inst.id);
    if (!s1 || s1.lastVisit == null) {
      t.skip('gate state not exposed through GET /api/platform/instances/:id');
      return;
    }
    await sleep(50);
    for (let i = 0; i < 3; i++) expectStatus(await instanceFetch(member, inst.host, `/read-${i}`), 200);
    const s2 = await gateState(inst.id);
    assert.equal(s2.lastVisit, s1.lastVisit, 'reads within the pass left no visit');
    await sleep(50);
    expectStatus(await instanceFetch(member, inst.host, '/write', { method: 'POST', body: {} }), 200);
    const s3 = await gateState(inst.id);
    assert.ok(s3.lastVisit > s1.lastVisit, 'a POST is checked with the gate object');
    assert.ok(s3.sessions >= 1);
  });

  it('removed from the team: writes and WebSockets refused at once, reads until the pass ends', async () => {
    const { admin, orgId, teamId, inst } = fx;
    const p = await inviteAndJoin(admin, orgId, 'rv-victim');
    await addToTeam(admin, orgId, teamId, p.id);
    await signInToInstance(p, inst.host);
    expectStatus(await instanceFetch(p, inst.host, '/fresh-pass', { method: 'POST', body: {} }), 200);
    const passStarted = Date.now();

    await removeFromTeam(admin, orgId, teamId, p.id);

    const ws = await openWebSocket(`ws://${inst.host}:${GATE_PORT}/ws`, { browser: p.browser });
    assert.equal(ws.ok, false, 'WebSocket upgrade refused');
    const post = await instanceFetch(p, inst.host, '/after', { method: 'POST', body: {} });
    assert.equal(post.status, 401, `POST right after removal: ${post.describe()}`);
    assert.ok(Date.now() - passStarted < PASS_SECONDS * 1000, 'all of this happened inside the pass window');
    // (The 401 also cleared the gate cookie here; reads within the pass are the next test.)
  });

  it('reads keep working within the pass after revocation, and stop when it runs out', { skip: expirySkip }, async () => {
    const { admin, orgId, teamId, inst } = fx;
    const p = await inviteAndJoin(admin, orgId, 'rv-reader');
    await addToTeam(admin, orgId, teamId, p.id);
    await signInToInstance(p, inst.host);
    expectStatus(await instanceFetch(p, inst.host, '/fresh-pass', { method: 'POST', body: {} }), 200);
    const passStarted = Date.now();
    await removeFromTeam(admin, orgId, teamId, p.id);

    const read = await instanceFetch(p, inst.host, '/read');
    if (Date.now() - passStarted < PASS_SECONDS * 1000) {
      assert.equal(read.status, 200, `a read within the pass still passes (D44): ${read.describe()}`);
    }
    await sleep(Math.max(0, passStarted + PASS_SECONDS * 1000 + 1000 - Date.now()));
    const later = await instanceFetch(p, inst.host, '/read');
    assert.equal(later.status, 401, `read after the pass: ${later.describe()}`);
    const nav = await p.browser.navigate(`http://${inst.host}:${GATE_PORT}/`);
    assert.equal(nav.final.status, 403, `navigation ends on the control plane's refusal: ${nav.final.describe()}`);
  });

  it('signing out of the control plane drops gate sessions (D46)', async () => {
    const { member, inst } = fx;
    const p = new Person(member.email, 'rv-signout');
    expectStatus(await p.signInWithCode(), 200);
    await signInToInstance(p, inst.host);
    expectStatus(await instanceFetch(p, inst.host, '/w', { method: 'POST', body: {} }), 200);
    await p.signOut();
    assert.equal(await p.me(), null, 'signed out of the control plane');
    const post = await instanceFetch(p, inst.host, '/w', { method: 'POST', body: {} });
    assert.equal(post.status, 401, post.describe());
  });

  it('unassigning the team from the instance drops sessions (D46)', async () => {
    const { admin, orgId, teamId, inst, member } = fx;
    const p = new Person(member.email, 'rv-unassign');
    expectStatus(await p.signInWithCode(), 200);
    await signInToInstance(p, inst.host);
    // An instance keeps at least one team (D71): move it to a team the member isn't in.
    const elsewhere = await createTeam(admin, orgId, 'rv elsewhere');
    expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/teams`, { teamIds: [elsewhere] }), 200, 'unassign');
    try {
      const post = await instanceFetch(p, inst.host, '/w', { method: 'POST', body: {} });
      assert.equal(post.status, 401, post.describe());
    } finally {
      expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/teams`, { teamIds: [teamId] }), 200, 'reassign');
    }
  });

  it('the identity token is renewed server to server when close to expiry (D45)', { skip: process.env.E2E_SLOW === '1' ? false : 'needs E2E_SLOW=1 (waits for the 5-minute token to near expiry)' }, async () => {
    const { member, inst } = fx;
    const { echo } = await signInToInstance(member, inst.host);
    const exp = echo.identity.exp;
    await sleep(Math.max(0, (exp - 110) * 1000 - Date.now()));
    const res = await instanceFetch(member, inst.host, '/late', { method: 'POST', body: {} });
    assert.equal(res.status, 200, res.describe());
    assert.ok(res.json().identity.exp > exp, 'a fresh token');
  });
});

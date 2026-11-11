// (c) Instance lifecycle with the fake providers against the stub (architecture.md "Creating an
// instance", instance-lifecycle.md; D16, D26, D29, D30, D33, D47, D60).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, APP_ORIGIN, instanceOrigin } from './lib/config.mjs';
import { request } from './lib/http.mjs';
import { Browser } from './lib/browser.mjs';
import { mailMark, waitForMail } from './lib/mail.mjs';
import {
  addToTeam, createTeam, deleteInstanceConfirmed, eventually, expectStatus, getInstance, getSuperadmin, inviteAndJoin,
  newTenant, setStubReport, stubInstance, submitConfirmation, visitInstance, waitForGateHost, waitForStatus,
} from './lib/flows.mjs';

const skip = await skipUnlessUp();

describe('instance lifecycle', { skip }, () => {
  let admin, orgId, teamId, member, inst;
  const name = `lifecycle-${Date.now().toString(36)}`;

  before(async () => {
    ({ admin, orgId } = await newTenant('i-admin'));
    teamId = await createTeam(admin, orgId, 'Ops');
    member = await inviteAndJoin(admin, orgId, 'i-member');
    await addToTeam(admin, orgId, teamId, member.id);
  });

  it('create needs a team of the org (D71)', async () => {
    const none = await admin.post(`/api/orgs/${orgId}/instances`, { name });
    assert.equal(none.status, 400, none.describe());
    assert.match(none.text, /team_required/);
    const foreign = await admin.post(`/api/orgs/${orgId}/instances`, { name, teamId: 'not-a-team' });
    assert.equal(foreign.status, 404, foreign.describe());
    assert.match(foreign.text, /team_not_found/);
  });

  it('create: the stub gets the project, variables and deploy; the first heartbeat makes it running', async () => {
    const res = expectStatus(await admin.post(`/api/orgs/${orgId}/instances`, { name, teamId }), 201, 'create');
    const created = res.json();
    assert.equal(created.status, 'creating');
    assert.match(created.host, /^[a-z2-9]{10}\.run\.localhost$/, 'random 10-char slug (D8)');
    assert.notEqual(created.keyHost, created.host, 'separate key page host (D9)');
    assert.deepEqual(created.teamIds, [teamId]);

    const stub = await eventually(async () => {
      const s = await stubInstance(created.id);
      return s && s.state === 'running' && s.beats > 0 ? s : false;
    }, { timeoutMs: 60_000, what: 'stub instance running with heartbeats' });
    assert.equal(stub.host, created.host);
    assert.equal(stub.keyHost, created.keyHost);
    const v = stub.variables;
    // Locally the control plane may hand out 127.0.0.1 instead of app.localhost (same server).
    assert.ok([`${APP_ORIGIN}/api/heartbeat`, `${APP_ORIGIN.replace('app.localhost', '127.0.0.1')}/api/heartbeat`].includes(v.heartbeatUrl), v.heartbeatUrl);
    assert.equal(v.identityIssuer, APP_ORIGIN);
    assert.equal(v.identityAudience, created.host);
    assert.equal(v.keyPageAudience, created.keyHost);
    assert.equal(v.allowedHosts, created.host, 'exact host only (W2)');
    assert.ok(v.heartbeatCredential?.length >= 20, 'heartbeat credential set');
    assert.ok(v.tunnelToken, 'tunnel token set');
    // D73: the org's outbound network policy (open until changed), always all three, never the old fixed list.
    assert.equal(v.egress.mode, 'open');
    assert.match(v.egress.allow, /worca-platform-broker\.railway\.internal/);
    assert.equal(v.egress.deny, '.invalid');
    assert.equal(v.egressAllowlist, undefined);

    inst = await waitForStatus(admin, orgId, created.id, 'running');
    inst.name = name;
    await waitForGateHost(inst.host);
    assert.equal(inst.version, stub.report.version);
    assert.ok(inst.lastHeartbeatAt > 0);
    assert.equal(inst.url.replace(/\/$/, ''), instanceOrigin(inst.host));
  });

  it('the tier allows one instance (D33)', async () => {
    const res = await admin.post(`/api/orgs/${orgId}/instances`, { name: 'second', teamId });
    assert.equal(res.status, 403, res.describe());
    assert.match(res.text, /tier_limit/);
  });

  it('heartbeats need the instance credential and carry counts only (D28)', async () => {
    const forged = await request(`${APP_ORIGIN}/api/heartbeat`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-credential' },
      body: { health: 'ok', version: '9.9.9', pipelines: {}, nextScheduledAt: null, suspendable: true },
    });
    assert.equal(forged.status, 401);
    await setStubReport(inst.id, { pipelines: { running: 2, queued: 1 }, suspendable: false });
    const seen = await eventually(async () => {
      const i = await getInstance(admin, orgId, inst.id);
      return i?.pipelines?.running === 2 ? i : false;
    }, { what: 'pipeline counts from the heartbeat' });
    assert.equal(seen.suspendable, false);
    await setStubReport(inst.id, { pipelines: {}, suspendable: true });
  });

  it('tenant users see the instance their team grants, but cannot change it', async () => {
    const list = expectStatus(await member.get(`/api/orgs/${orgId}/instances`), 200).json().instances;
    assert.deepEqual(list.map((i) => i.id), [inst.id]);
    assert.equal((await member.post(`/api/orgs/${orgId}/instances/${inst.id}/upgrade`, {})).status, 403);
    assert.equal((await member.post(`/api/orgs/${orgId}/instances/${inst.id}/delete`, { confirmName: name })).status, 403);
  });

  it('outbound network (D73): the org policy reaches the worca service, an override replaces it, members read it', async () => {
    /** Waits until the policy is applied: the stub holds `want` and nothing is pending or running. */
    const applied = (want) => eventually(async () => {
      const [s, eg, i] = [await stubInstance(inst.id), (await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/egress`)).json(), await getInstance(admin, orgId, inst.id)];
      return s?.variables?.egress?.mode === want.mode && s.variables.egress.deny === want.deny && !eg.pending && i.op?.status !== 'running' && s.state === 'running' ? s.variables.egress : false;
    }, { timeoutMs: 60_000, what: `egress ${JSON.stringify(want)} applied` });

    const org = expectStatus(await admin.get(`/api/orgs/${orgId}/egress`), 200).json();
    assert.deepEqual(org.policy, { mode: 'open', allow: [], deny: [] });
    assert.deepEqual(org.instances, { inheriting: 1, inheritingRunning: 1, overriding: 0 });
    const bad = await admin.put(`/api/orgs/${orgId}/egress`, { policy: { mode: 'block', deny: ['https://x.com'] }, version: org.version });
    assert.equal(bad.status, 400, bad.describe());
    assert.deepEqual({ ...bad.json(), entry: bad.json().entry }, { error: 'egress_host_invalid', field: 'deny', entry: 'https://x.com', reason: 'scheme' });

    const saved = expectStatus(await admin.put(`/api/orgs/${orgId}/egress`, { policy: { mode: 'block', deny: ['pastebin.com'] }, version: org.version }), 200, 'org policy').json();
    assert.deepEqual([saved.result, saved.applying, saved.applyingIds], ['saved', 1, [inst.id]]);
    await applied({ mode: 'block', deny: 'pastebin.com' });
    const stale = await admin.put(`/api/orgs/${orgId}/egress`, { policy: { mode: 'open' }, version: org.version });
    assert.equal(stale.status, 409, stale.describe());
    assert.match(stale.text, /egress_changed/);

    const seen = expectStatus(await member.get(`/api/orgs/${orgId}/instances/${inst.id}/egress`), 200).json();
    assert.deepEqual([seen.inherited, seen.effective], [true, { mode: 'block', allow: [], deny: ['pastebin.com'] }]);
    assert.equal((await member.put(`/api/orgs/${orgId}/instances/${inst.id}/egress`, { policy: null, version: seen.version })).status, 403);

    const own = expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/egress`, {
      policy: { mode: 'allow', allow: ['github.com', '*.npmjs.org'], deny: ['pastebin.com'] }, version: seen.version,
    }), 200, 'override').json();
    assert.equal(own.result, 'applying');
    const allow = await applied({ mode: 'allow', deny: 'pastebin.com' });
    assert.match(allow.allow, /,github\.com,\.npmjs\.org$/);

    const back = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/egress`), 200).json();
    assert.equal(back.inherited, false);
    expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/egress`, { policy: null, version: back.version }), 200, 'reset');
    await applied({ mode: 'block', deny: 'pastebin.com' });
    // Leave the org open for the tests that follow.
    const v2 = expectStatus(await admin.get(`/api/orgs/${orgId}/egress`), 200).json().version;
    expectStatus(await admin.put(`/api/orgs/${orgId}/egress`, { policy: { mode: 'open' }, version: v2 }), 200, 'org open again');
    await applied({ mode: 'open', deny: '.invalid' });
  });

  it('upgrade: only when a tenant admin starts it; running again once the new version reports (D26)', async (t) => {
    const same = await admin.post(`/api/orgs/${orgId}/instances/${inst.id}/upgrade`, { version: inst.version });
    assert.equal(same.status, 409, `already on that version: ${same.describe()}`);
    const sa = await getSuperadmin();
    const next = bump(inst.version);
    // Publishing a release is a platform action; skip when the console has no endpoint for it yet.
    const publish = await sa.put('/api/platform/worca-version', { version: next });
    if (publish.status === 404) {
      t.skip(`no platform endpoint to publish worca ${next} (PUT /api/platform/worca-version -> 404)`);
      return;
    }
    expectStatus(publish, [200, 201, 204], 'publish version');
    const up = expectStatus(await admin.post(`/api/orgs/${orgId}/instances/${inst.id}/upgrade`, { version: next }), 202, 'upgrade');
    assert.equal(up.json().status, 'upgrading');
    await eventually(async () => (await stubInstance(inst.id))?.report.version === next, { timeoutMs: 60_000, what: 'stub redeployed with the new image' });
    const done = await waitForStatus(admin, orgId, inst.id, 'running');
    assert.equal(done.version, next);
    inst.version = next;
  });

  it('stop for abuse: platform only, tenant admins notified, a visit never wakes it; lift (D16, D47)', async () => {
    const sa = await getSuperadmin();
    assert.equal((await admin.post(`/api/platform/instances/${inst.id}/stop`, { reason: 'x' })).status, 403, 'tenant admins cannot');
    const before = await mailMark(admin.email);
    expectStatus(await sa.post(`/api/platform/instances/${inst.id}/stop`, { reason: 'e2e: phishing page' }), 200, 'stop');
    await waitForStatus(admin, orgId, inst.id, 'stopped');
    await eventually(async () => (await stubInstance(inst.id))?.state === 'stopped', { what: 'stub stopped' });
    const mail = await waitForMail(admin.email, { after: before, match: (m) => /stopped/i.test(m.subject) });
    assert.match(mail.text, /e2e: phishing page/);

    const { final } = await visitInstance(member, inst.host);
    assert.equal(final.status, 403, final.describe());
    assert.match(final.text, /stopped by the platform/i);
    assert.match(final.text, /abuse@example\.com/, 'abuse contact on the stopped page (D58)');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await stubInstance(inst.id)).state, 'stopped', 'the visit did not wake it');
    assert.equal((await getInstance(admin, orgId, inst.id)).status, 'stopped');

    const platformView = expectStatus(await sa.get(`/api/platform/instances/${inst.id}`), 200).json();
    assert.equal(platformView.status, 'stopped');
    assert.equal(typeof platformView.name, 'string', 'D61: platform staff see instance names');
    assert.equal(platformView.pipelines === undefined || typeof platformView.pipelines === 'object', true, 'status only (D15)');

    expectStatus(await sa.post(`/api/platform/instances/${inst.id}/lift`), 200, 'lift');
    await waitForStatus(admin, orgId, inst.id, 'running');
    assert.equal((await stubInstance(inst.id)).state, 'running');
  });

  it('delete: typed name, then the emailed link; GET shows a form and does nothing (D29, D30)', async () => {
    const wrong = await admin.post(`/api/orgs/${orgId}/instances/${inst.id}/delete`, { confirmName: 'not-the-name' });
    assert.equal(wrong.status, 422, wrong.describe());
    assert.equal(wrong.json().error, 'confirm_name_mismatch');
    const statusBefore = (await getInstance(admin, orgId, inst.id))?.status; // running, or stopped (D60)
    const stubBefore = (await stubInstance(inst.id))?.state;
    const link = await deleteInstanceConfirmed(admin, orgId, inst);

    for (let i = 0; i < 2; i++) {
      const page = await admin.browser.fetch(link, { navigate: true });
      assert.equal(page.status, 200, page.describe());
      assert.match(page.text, /<form[^>]+method="post"/i);
    }
    const anon = await new Browser('scanner').fetch(link, { navigate: true });
    assert.ok([401, 302].includes(anon.status), `a scanner without a session gets no form: ${anon.describe()}`);
    assert.equal((await getInstance(admin, orgId, inst.id))?.status, statusBefore, 'GET did nothing');
    assert.equal((await stubInstance(inst.id))?.state, stubBefore);

    const done = await submitConfirmation(admin, link);
    assert.equal(done.status, 200, done.describe());
    await eventually(async () => (await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`)).status === 404, { timeoutMs: 60_000, what: 'instance row gone' });
    await eventually(async () => (await stubInstance(inst.id)) === null, { timeoutMs: 60_000, what: 'stub project destroyed' });
    const visit = await member.browser.fetch(`${instanceOrigin(inst.host)}/`, { navigate: true });
    assert.equal(visit.status, 404, `host no longer served: ${visit.describe()}`);
    assert.equal((await submitConfirmation(admin, link)).status, 410, 'link is single use');
  });
});

function bump(version) {
  const [a, b, c] = String(version ?? '1.8.0').split('.').map(Number);
  return `${a}.${b}.${(c || 0) + 1}`;
}

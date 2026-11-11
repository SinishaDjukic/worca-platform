// (b) Orgs, teams, invitations, roles and guards (D15, D17–D19, D21, D30, D31).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from './lib/config.mjs';
import { extractLink, mailMark, waitForMail } from './lib/mail.mjs';
import {
  addToTeam, createTeam, expectStatus, getSuperadmin, inviteAndJoin, newTenant, signUp, submitConfirmation,
} from './lib/flows.mjs';

const skip = await skipUnlessUp();

describe('orgs, teams, invitations and roles', { skip }, () => {
  let admin, orgId, member, outsider, teamId;

  before(async () => {
    ({ admin, orgId } = await newTenant('t-admin'));
    outsider = await signUp('t-outsider');
  });

  it('the creator is the first tenant admin', async () => {
    const org = expectStatus(await admin.get(`/api/orgs/${orgId}`), 200).json();
    assert.equal(org.role, 'tenant_admin');
    assert.equal(org.tier?.id, 'free');
    const me = await admin.me();
    assert.ok(me.orgs.some((o) => o.id === orgId && o.role === 'tenant_admin'));
  });

  it('non-members get 404 for everything under the org (no probing)', async () => {
    for (const path of ['', '/members', '/teams', '/instances', '/invitations', '/audit']) {
      const res = await outsider.get(`/api/orgs/${orgId}${path}`);
      assert.equal(res.status, 404, `${path}: ${res.describe()}`);
    }
    const write = await outsider.post(`/api/orgs/${orgId}/teams`, { name: 'x' });
    assert.equal(write.status, 404, write.describe());
  });

  it('invites a member by email; the link joins them as tenant user', async () => {
    member = await inviteAndJoin(admin, orgId, 't-member');
    const org = expectStatus(await member.get(`/api/orgs/${orgId}`), 200).json();
    assert.equal(org.role, 'tenant_user');
    const members = expectStatus(await admin.get(`/api/orgs/${orgId}/members`), 200).json().members;
    assert.ok(members.some((m) => m.userId === member.id && m.role === 'tenant_user' && m.email === member.email), 'listed, email decrypted');
  });

  it('a tenant user cannot manage the org', async () => {
    // D62: members see the team list (names, counts), never the instance grants.
    const teams = expectStatus(await member.get(`/api/orgs/${orgId}/teams`), 200).json().teams;
    assert.ok(teams.every((t) => t.instanceIds === undefined), 'no grants for tenant users');
    assert.equal((await member.post(`/api/orgs/${orgId}/teams`, { name: 'x' })).status, 403);
    assert.equal((await member.post(`/api/orgs/${orgId}/invitations`, { email: 'x@e2e.test' })).status, 403);
    assert.equal((await member.patch(`/api/orgs/${orgId}/members/${admin.id}`, { role: 'tenant_user' })).status, 403);
    assert.equal((await member.post(`/api/orgs/${orgId}/instances`, { name: 'x' })).status, 403);
  });

  it('teams: create, add a member, list', async () => {
    teamId = await createTeam(admin, orgId, 'Builders');
    await addToTeam(admin, orgId, teamId, member.id);
    const again = await admin.post(`/api/orgs/${orgId}/teams/${teamId}/members`, { userId: member.id });
    assert.equal(again.status, 409, 'already a member');
    const teams = expectStatus(await admin.get(`/api/orgs/${orgId}/teams`), 200).json().teams;
    const team = teams.find((t) => t.id === teamId);
    assert.equal(team.name, 'Builders', 'name decrypted');
    assert.equal(team.members, 1);
    const tm = expectStatus(await admin.get(`/api/orgs/${orgId}/teams/${teamId}/members`), 200).json().members;
    assert.deepEqual(tm.map((m) => m.userId), [member.id]);
    const notMember = await admin.post(`/api/orgs/${orgId}/teams/${teamId}/members`, { userId: outsider.id });
    assert.equal(notMember.status, 404, 'only org members can join teams');
  });

  it('there is always one tenant admin (D18)', async () => {
    const demote = await admin.patch(`/api/orgs/${orgId}/members/${admin.id}`, { role: 'tenant_user' });
    assert.equal(demote.status, 409, demote.describe());
    const leave = await admin.del(`/api/orgs/${orgId}/members/${admin.id}`);
    assert.equal(leave.status, 409, leave.describe());
    // With a second admin, the first may step down; then the second can't.
    expectStatus(await admin.patch(`/api/orgs/${orgId}/members/${member.id}`, { role: 'tenant_admin' }), 200, 'promote');
    expectStatus(await member.patch(`/api/orgs/${orgId}/members/${admin.id}`, { role: 'tenant_user' }), 200, 'demote first admin');
    assert.equal((await member.patch(`/api/orgs/${orgId}/members/${member.id}`, { role: 'tenant_user' })).status, 409);
    // Restore.
    expectStatus(await member.patch(`/api/orgs/${orgId}/members/${admin.id}`, { role: 'tenant_admin' }), 200);
    expectStatus(await admin.patch(`/api/orgs/${orgId}/members/${member.id}`, { role: 'tenant_user' }), 200);
  });

  it('platform staff get no tenant access from their role (D15)', async () => {
    const sa = await getSuperadmin();
    assert.equal((await sa.get(`/api/orgs/${orgId}`)).status, 404);
    assert.equal((await sa.get(`/api/orgs/${orgId}/instances`)).status, 404);
    const orgs = expectStatus(await sa.get('/api/platform/orgs'), 200).json().orgs;
    const row = orgs.find((o) => o.id === orgId);
    assert.ok(row, 'org listed on the platform console');
    assert.equal(row.name, `Org of ${admin.email}`, 'D61: platform staff see org names');
  });

  it('a member may leave; an admin may remove members; audit log records it (D41)', async () => {
    const extra = await inviteAndJoin(admin, orgId, 't-leaver');
    expectStatus(await extra.del(`/api/orgs/${orgId}/members/${extra.id}`), 200, 'leave');
    assert.equal((await extra.get(`/api/orgs/${orgId}`)).status, 404, 'gone after leaving');
    const audit = expectStatus(await admin.get(`/api/orgs/${orgId}/audit`), 200).json().entries;
    const actions = audit.map((e) => e.action);
    for (const a of ['org.created', 'team.created', 'team.member_added', 'invitation.created', 'member.removed']) {
      assert.ok(actions.includes(a), `audit has ${a}: ${actions.join(', ')}`);
    }
    assert.equal((await member.get(`/api/orgs/${orgId}/audit`)).status, 403, 'tenant users cannot read the audit log');
  });

  it('deleting the org needs the typed name, MFA and the emailed link; GET alone does nothing (D30)', async () => {
    const t = await newTenant('t-del');
    const wrongName = await t.admin.del(`/api/orgs/${t.orgId}`, { confirmName: 'nope' });
    assert.equal(wrongName.status, 422, wrongName.describe());
    const before = await mailMark(t.admin.email);
    expectStatus(await t.admin.del(`/api/orgs/${t.orgId}`, { confirmName: t.orgName }), 202, 'start org delete');
    const mail = await waitForMail(t.admin.email, { after: before, match: (m) => /confirm/i.test(m.subject) });
    const link = extractLink(mail, '/confirm/');
    // A mail scanner (no cookies) and the signed-in user's GET both only show a page.
    const scanner = await (await signUp('t-scanner')).browser.fetch(link, { navigate: true });
    assert.notEqual(scanner.status, 200, 'someone else gets no form');
    const page = await t.admin.browser.fetch(link, { navigate: true });
    assert.equal(page.status, 200, page.describe());
    assert.match(page.text, /<form[^>]+method="post"/i);
    expectStatus(await t.admin.get(`/api/orgs/${t.orgId}`), 200, 'still there after GET');
    const done = await submitConfirmation(t.admin, link);
    assert.equal(done.status, 200, done.describe());
    assert.equal((await t.admin.get(`/api/orgs/${t.orgId}`)).status, 404, 'deleted');
    const reuse = await submitConfirmation(t.admin, link);
    assert.equal(reuse.status, 410, 'single use');
  });
});

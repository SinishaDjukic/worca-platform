// People views (ui/assets/js/views/people.mjs): the member directory with invitations and member
// management, teams and a team's detail, for tenant admins and tenant users (D62).
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { createTeam, addToTeam, expectStatus, inviteAndJoin, newTenant, uniqueEmail } from '../e2e/lib/flows.mjs';
import { getMail, waitForMail } from '../e2e/lib/mail.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = process.env.UI_SHOTS; // a directory: also save screenshots there

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Records a Resend delivery event for an invitation's mail in the local D1 (as the webhook would). */
function setDelivery(invitationId, event) {
  const id = `ui-test-${invitationId}`;
  const now = Date.now();
  const sql = `INSERT OR REPLACE INTO mail_messages (email_id, ref, kind, sent_at, last_event, last_event_at) VALUES ('${id}', 'invitation:${invitationId}', 'invitation', ${now}, '${event}', ${now})`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'worca-platform-db-dev', '--local', '-c', 'wrangler.control.jsonc', '--env', 'dev', '--persist-to', process.env.PERSIST_TO || '.wrangler/state', '--command', sql], { cwd: ROOT, stdio: 'pipe' });
}

const toastText = async (page) => (await page.locator('#toasts .toast').last().innerText()).trim();
const waitToast = (page, re) => page.waitForFunction((src) => {
  return [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent));
}, re.source, { timeout: 15_000 });

describe('people', { skip }, () => {
  let admin, orgId, bob;
  before(async () => {
    ({ admin, orgId } = await newTenant('ui-ppl'));
    bob = await inviteAndJoin(admin, orgId, 'ui-ppl-bob');
  });
  after(closeBrowser);

  it('admin: directory with admin columns; invite, delivery status, resend, too soon, cancel', async () => {
    const t = await pageAs(admin);
    const { page } = t;
    await page.goto(`/o/${orgId}/members`);
    await settled(page);
    assert.equal(await page.locator('h1').innerText(), 'Members');
    const header = await page.locator('#panel-members thead').innerText();
    for (const col of ['Signs in with', 'Joined', 'Invited by']) assert.match(header, new RegExp(col));
    const bobRow = page.locator(`#mem-body tr[data-member="${bob.id}"]`);
    assert.match(await bobRow.innerText(), new RegExp(bob.email.replace(/[.+]/g, '\\$&')));
    assert.match(await bobRow.innerText(), /Email code/);
    assert.match(await page.locator(`#mem-body tr[data-member="${admin.id ?? (await admin.me()).user.id}"]`).innerText(), /\(you\)[\s\S]*Passkey/);

    // Invite someone: the mail arrives and the invitation is listed.
    const email = uniqueEmail('ui-ppl-inv');
    await page.click('#invite');
    await page.fill('#iv-mail', email);
    await page.click('#iv-go');
    await waitToast(page, /Invitation sent to/);
    const mail = await waitForMail(email, { match: (m) => /invit/i.test(m.subject) });
    assert.ok(mail, 'invitation mail captured');
    assert.equal(await page.locator('#tab-invitations').getAttribute('aria-selected'), 'true');
    const row = page.locator('#inv-body tr', { hasText: email });
    await row.waitFor();
    const invId = await row.getAttribute('data-invitation');
    assert.match(await row.innerText(), /Member/);

    // The same address again: refused with a plain message, the modal stays open.
    await page.click('#invite');
    await page.fill('#iv-mail', email);
    await page.click('#iv-go');
    await page.locator('#iv-err .banner').waitFor();
    assert.match(await page.locator('#iv-err').innerText(), /already has an open invitation/);
    await page.keyboard.press('Escape');

    // A bounced mail shows as such, with a banner.
    setDelivery(invId, 'bounced');
    await page.reload();
    await settled(page);
    assert.equal(await page.locator('#tab-invitations').getAttribute('aria-selected'), 'true', 'tab kept in the URL');
    assert.match(await page.locator(`#inv-body tr[data-invitation="${invId}"]`).innerText(), /Bounced/);
    assert.match(await page.locator('#inv-alert').innerText(), /didn't reach/);
    await shot(page, 'members-invitations');

    // Resend once works; right again is too soon.
    await page.click(`[data-resend="${invId}"]`);
    await waitToast(page, /Invitation sent again/);
    await page.click(`[data-resend="${invId}"]`);
    await waitToast(page, /less than 5 minutes ago/);
    assert.ok((await getMail(email)).filter((m) => /invit/i.test(m.subject)).length >= 2, 'resent mail captured');

    // Cancel.
    await page.click(`[data-cancel="${invId}"]`);
    await page.click('#cf-go');
    await waitToast(page, /canceled/);
    assert.equal(await page.locator(`#inv-body tr[data-invitation="${invId}"]`).count(), 0);
    assert.match(await page.locator('#inv-body').innerText(), /No open invitations/);
    t.assertNoErrors();
    await t.close();
  });

  it('admin: last-admin protection, role change, team membership, remove member; search', async () => {
    const meId = (await admin.me()).user.id;
    const carol = await inviteAndJoin(admin, orgId, 'ui-ppl-carol');
    const teamId = await createTeam(admin, orgId, 'Robotics');
    const t = await pageAs(admin);
    const { page } = t;
    await page.goto(`/o/${orgId}/members`);
    await settled(page);

    // Search filters the directory client-side.
    await page.fill('#ppl-q', carol.email.slice(0, 18));
    assert.equal(await page.locator('#mem-body tr[data-member]').count(), 1);
    await page.fill('#ppl-q', 'zzz-no-such-person');
    assert.match(await page.locator('#mem-body').innerText(), /No one matches/);
    await page.fill('#ppl-q', '');

    // The only admin can't make themselves a member.
    await page.click(`[data-manage="${meId}"]`);
    await page.selectOption('#mg-role', 'tenant_user');
    await page.click('#mg-save');
    await page.locator('#mg-err .banner').waitFor();
    assert.match(await page.locator('#mg-err').innerText(), /You are the last admin/);
    await page.keyboard.press('Escape');

    // ...nor leave.
    await page.click(`[data-manage="${meId}"]`);
    await page.click('#mg-rm');
    await page.click('#cf-go');
    // Refused: back in the person's dialog, which says why.
    await page.locator('#mg-err .banner').waitFor();
    assert.match(await page.locator('#mg-err').innerText(), /You are the last admin/);
    await page.keyboard.press('Escape');

    // Carol becomes an admin and joins a team.
    await page.click(`[data-manage="${carol.id}"]`);
    await page.selectOption('#mg-role', 'tenant_admin');
    await page.check(`#mg-form input[value="${teamId}"]`);
    await shot(page, 'members-manage');
    await page.click('#mg-save');
    await waitToast(page, /Saved changes/);
    const carolRow = page.locator(`#mem-body tr[data-member="${carol.id}"]`);
    assert.match(await carolRow.innerText(), /Admin[\s\S]*Robotics/);

    // Remove Carol.
    await page.click(`[data-manage="${carol.id}"]`);
    await page.click('#mg-rm');
    await page.click('#cf-go');
    await waitToast(page, /removed from/);
    assert.equal(await carolRow.count(), 0);
    const res = expectStatus(await admin.get(`/api/orgs/${orgId}/members`), 200).json();
    assert.ok(!res.members.some((m) => m.userId === carol.id));
    t.assertNoErrors();
    await t.close();
  });

  it('tenant user: the directory without admin columns, no invitations, no management', async () => {
    const t = await pageAs(bob);
    const { page } = t;
    await page.goto(`/o/${orgId}/members`);
    await settled(page);
    assert.equal(await page.locator('h1').innerText(), 'People');
    assert.match(await page.title(), /^People · worca$/i);
    const header = await page.locator('thead').innerText();
    assert.doesNotMatch(header, /Signs in with|Joined|Invited by/);
    assert.equal(await page.locator('#invite, #tab-invitations, [data-manage], [data-resend]').count(), 0);
    assert.ok(await page.locator('#mem-body tr', { hasText: 'Admin' }).count(), 'admins are marked');
    assert.match(await page.locator('#ppl-count').innerText(), /people/);
    await shot(page, 'people-tenant');
    t.assertNoErrors();
    await t.close();
  });

  it('teams: create, rename, add a member, grant and revoke an instance, delete; tenant view', async () => {
    const home = await createTeam(admin, orgId, 'Home');
    const inst = expectStatus(await admin.post(`/api/orgs/${orgId}/instances`, { name: 'ui-ppl-inst', teamId: home }), 201, 'create instance').json();
    const t = await pageAs(admin);
    const { page } = t;
    await page.goto(`/o/${orgId}/teams`);
    await settled(page);
    await page.click('#new-team');
    await page.fill('#an-name', 'Firmware');
    await page.click('#an-go');
    await page.waitForURL(/\/teams\/[^/]+$/);
    await settled(page);
    const teamId = new URL(page.url()).pathname.split('/').pop();
    assert.equal(await page.locator('h1').innerText(), 'Firmware');

    await page.click('#rename');
    await page.fill('#an-name', 'Firmware tools');
    await page.click('#an-go');
    await waitToast(page, /Renamed/);
    await page.locator('h1', { hasText: 'Firmware tools' }).waitFor();

    await page.click('#add-person');
    await page.selectOption('#ap-who', bob.id);
    await page.click('#ap-go');
    await waitToast(page, /Added/);
    await page.locator('[data-remove]').first().waitFor();
    assert.match(await page.locator('.list').innerText(), new RegExp(bob.email.replace(/[.+]/g, '\\$&')));

    await page.click(`label[for="ti-${inst.id}"]`);
    // A switch that applies at once shows its new state; no toast.
    await page.locator('.head p', { hasText: '1 instance' }).waitFor();
    assert.ok(await page.locator(`#ti-${inst.id}`).isChecked());
    await shot(page, 'team-detail');

    // The tenant user sees their team, and what it grants.
    const tb = await pageAs(bob);
    await tb.page.goto(`/o/${orgId}/teams`);
    await settled(tb.page);
    const mine = tb.page.locator('section', { hasText: 'Your teams' });
    assert.match(await mine.innerText(), /Firmware tools[\s\S]*ui-ppl-inst/);
    assert.equal(await tb.page.locator('#new-team').count(), 0);
    await shot(tb.page, 'teams-tenant');
    await tb.page.goto(`/o/${orgId}/teams/${teamId}`);
    await settled(tb.page);
    assert.equal(await tb.page.locator('#rename, #del-team, #add-person, [data-grant], [data-remove]').count(), 0);
    assert.match(await tb.page.locator('main').innerText(), /ui-ppl-inst/);
    tb.assertNoErrors();
    await tb.close();

    // Revoke: the switch shows it; a toast only when people were signed out (none had a gate session here).
    await page.click(`label[for="ti-${inst.id}"]`);
    await page.locator('.head p', { hasText: '0 instances' }).waitFor();
    assert.equal(await page.locator(`#ti-${inst.id}`).isChecked(), false);

    // Remove Bob again, then delete the team with its typed name.
    await page.click(`[data-remove="${bob.id}"]`);
    await page.click('#cf-go');
    await waitToast(page, /Removed/);
    await page.click('#del-team');
    await page.fill('#pa-name', 'Firmware tools');
    await page.click('#pa-go');
    await page.waitForURL(new RegExp(`/o/${orgId}/teams$`));
    await settled(page);
    assert.equal(await page.locator(`a[data-team="${teamId}"]`).count(), 0);
    assert.match(await toastText(page), /deleted/);

    // Home is the instance's only team (D71): its grant can't be switched off, nor the team deleted.
    await page.goto(`/o/${orgId}/teams/${home}`);
    await settled(page);
    assert.ok(await page.locator(`a#new-inst[href="/o/${orgId}/instances/new?team=${home}"]`).count(), 'new instance in this team');
    await page.click(`label[for="ti-${inst.id}"]`);
    await waitToast(page, /only team of that instance/);
    assert.ok(await page.locator(`#ti-${inst.id}`).isChecked());
    await page.click('#del-team');
    assert.match(await page.locator('.modal').innerText(), /can't be deleted yet[\s\S]*ui-ppl-inst/);
    await page.click('.modal [data-close]');
    assert.ok(expectStatus(await admin.get(`/api/orgs/${orgId}/teams`), 200).json().teams.some((x) => x.id === home));
    t.assertNoErrors();
    await t.close();
  });

  it('teams list shows members and grants; phone width has no sideways scroll', async () => {
    const teamId = await createTeam(admin, orgId, 'Platform');
    await addToTeam(admin, orgId, teamId, bob.id);
    const t = await pageAs(admin, { viewport: { width: 390, height: 844 } });
    const { page } = t;
    await page.goto(`/o/${orgId}/teams`);
    await settled(page);
    assert.match(await page.locator(`a[data-team="${teamId}"]`).innerText(), /Platform[\s\S]*1 person/);
    await assertNoHorizontalScroll(page);
    await page.goto(`/o/${orgId}/members`);
    await settled(page);
    await assertNoHorizontalScroll(page);
    await shot(page, 'members-phone');
    t.assertNoErrors();
    await t.close();
  });
});

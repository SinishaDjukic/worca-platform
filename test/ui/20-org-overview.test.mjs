// /o/:orgId: the tenant admin's Overview, and the instances a tenant user's teams grant.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { addToTeam, createRunningInstance, createTeam, expectStatus, inviteAndJoin, newTenant, uniqueEmail } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();
const SHOTS = process.env.UI_SHOTS; // optional directory for screenshots
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null);

describe('org overview', { skip }, () => {
  let fx;
  before(async () => {
    const { admin, orgId, orgName } = await newTenant('ui-ov');
    const teamId = await createTeam(admin, orgId, 'Mobile');
    const member = await inviteAndJoin(admin, orgId, 'ui-ov-user');
    await addToTeam(admin, orgId, teamId, member.id);
    const loner = await inviteAndJoin(admin, orgId, 'ui-ov-loner');
    const granted = await createRunningInstance(admin, orgId, { name: 'Mobile app', teamIds: [teamId] });
    const invitee = uniqueEmail('ui-ov-invitee');
    expectStatus(await admin.post(`/api/orgs/${orgId}/invitations`, { email: invitee, role: 'tenant_user' }), 201, 'invite');
    fx = { admin, orgId, orgName, teamId, member, loner, granted, invitee };
  });
  after(closeBrowser);

  it('a tenant admin sees instances, the open invitation and recent activity, and the links work', async () => {
    const { admin, orgId, granted, invitee } = fx;
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    const main = t.page.locator('#main');
    assert.equal(await main.locator('h1').innerText(), 'Overview');
    // One team: the action goes straight to a new instance in it (D71).
    assert.ok(await main.locator(`a.btn.primary[href="/o/${orgId}/instances/new?team=${fx.teamId}"]`).count(), 'New instance action');
    assert.equal(await main.locator('#setup').count(), 0, 'set up already: no checklist');
    // Tiles: 1 of 1 instances (the free tier), 3 members (admin + 2), 1 open invitation.
    const instTile = main.locator(`a.tile[href="/o/${orgId}/instances"]`).first();
    assert.match(await instTile.innerText(), /Instances\s+1\s*\/\s*1/);
    const memTile = main.locator(`a.tile[href="/o/${orgId}/members"]`);
    assert.match(await memTile.innerText(), /Members\s+3/);
    assert.match(await memTile.innerText(), /1 invitation open/);
    assert.ok(await main.locator(`a.tile[href="/o/${orgId}/security"]`).count(), 'sign-in tile');
    // The instance row links to the detail and names its team; at the tier limit, that needs attention.
    assert.ok(await main.locator(`a.row[href="/o/${orgId}/instances/${granted.id}"]`, { hasText: granted.name }).count(), 'instance row');
    assert.match(await main.locator(`a.row[href="/o/${orgId}/instances/${granted.id}"]`).innerText(), /Mobile/);
    assert.match(await main.locator('.card', { hasText: 'Needs you' }).innerText(), /Every instance your plan allows is in use/);
    // Invitations live 7 days: a fresh one isn't "expiring" yet, so it doesn't need attention.
    assert.equal(await main.locator('.ov-needs a.row', { hasText: `Invitation to ${invitee}` }).count(), 0, 'fresh invitation is not expiring');
    // Recent activity in plain language, with the actor and a link to the audit log.
    const activity = main.locator('.ov-activity');
    await activity.waitFor();
    assert.match(await activity.innerText(), new RegExp(`Invited ${invitee.replace(/[.+]/g, '\\$&')} as a member`));
    assert.match(await activity.innerText(), new RegExp(admin.email.replace(/[.+]/g, '\\$&')));
    assert.ok(await main.locator(`a[href="/o/${orgId}/audit"]`).count(), 'audit log link');
    await shot(t.page, 'admin-light');
    // Links navigate inside the app.
    await main.locator(`a.row[href="/o/${orgId}/instances/${granted.id}"]`).click();
    await t.page.waitForURL(`**/o/${orgId}/instances/${granted.id}`);
    await t.page.goBack();
    await settled(t.page);
    await t.page.locator(`a.tile[href="/o/${orgId}/members"]`).click();
    await t.page.waitForURL(`**/o/${orgId}/members`);
    t.assertNoErrors();
    await t.close();
  });

  it('first-time setup: a new org is led to its first team, then to an instance in it (D71)', async () => {
    const { admin, orgId } = await newTenant('ui-setup');
    const t = await pageAs(admin);
    // No team yet: creating an instance starts with the team.
    await t.page.goto(`/o/${orgId}/instances/new`);
    await settled(t.page);
    assert.match(await t.page.locator('#c-team-first').innerText(), /Create a team first[\s\S]*Instances belong to teams/);
    assert.equal(await t.page.locator('#create-form').count(), 0, 'no instance form without a team');

    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    const main = t.page.locator('#main');
    const setup = main.locator('#setup');
    assert.match(await setup.innerText(), /Get started[\s\S]*Step 1 of 2[\s\S]*Instances belong to teams[\s\S]*Create the first team[\s\S]*Create the first instance in it/);
    assert.match(await main.locator('.head .acts').innerText(), /Create a team first/);
    assert.equal(await main.locator(`a[href^="/o/${orgId}/instances/new"]`).count(), 0, 'no way to an instance without a team');
    await shot(t.page, 'setup-step1');
    await setup.locator('[data-first-team]').click();
    assert.equal(await t.page.locator('#ft-name').inputValue(), 'Core', 'a name is suggested');
    await t.page.fill('#ft-name', 'Founders');
    await t.page.click('#ft-go');
    await t.page.waitForURL(new RegExp(`/o/${orgId}/instances/new\\?team=`));
    await settled(t.page);
    const teamId = new URL(t.page.url()).searchParams.get('team');
    assert.equal(await t.page.locator('#c-team').inputValue(), teamId, 'the new team is picked');
    const mine = expectStatus(await admin.get(`/api/orgs/${orgId}/teams/mine`), 200).json().teams;
    assert.deepEqual(mine.map((x) => [x.id, x.name]), [[teamId, 'Founders']], 'the admin is in the new team');

    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    assert.match(await setup.innerText(), /Step 2 of 2[\s\S]*Founders is ready/);
    assert.ok(await setup.locator(`a[href="/o/${orgId}/instances/new?team=${teamId}"]`).count(), 'next: an instance in that team');
    await shot(t.page, 'setup-step2');
    t.assertNoErrors();
    await t.close();
  });

  it('dark mode and phone width', async () => {
    const t = await pageAs(fx.admin, { viewport: { width: 390, height: 860 }, colorScheme: 'dark' });
    await t.page.goto(`/o/${fx.orgId}`);
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    await shot(t.page, 'admin-phone-dark');
    t.assertNoErrors();
    await t.close();
  });

  it('a tenant user sees exactly the instances their team grants, and which team grants them', async () => {
    const { member, orgId, orgName, granted } = fx;
    const t = await pageAs(member);
    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    const main = t.page.locator('#main');
    assert.equal(await main.locator('h1').innerText(), 'Instances');
    const cards = main.locator('article.ov-card');
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().getAttribute('data-instance'), granted.id);
    assert.match(await cards.first().innerText(), /Mobile app/);
    const open = cards.first().locator('a.btn', { hasText: 'Open' });
    assert.equal(await open.getAttribute('href'), granted.url);
    const banner = await main.locator('.banner').innerText();
    assert.match(banner, /Mobile/);
    assert.ok(banner.includes(`Ask an admin of ${orgName} if you need another`), banner);
    // Admin-only data is not requested or shown.
    assert.equal(await main.locator('.tile').count(), 0);
    await shot(t.page, 'user-light');
    t.assertNoErrors();
    await t.close();
  });

  it('a tenant user whose teams grant nothing sees the empty state, not the org\'s instance', async () => {
    const t = await pageAs(fx.loner);
    await t.page.goto(`/o/${fx.orgId}`);
    await settled(t.page);
    const main = t.page.locator('#main');
    assert.equal(await main.locator('article.ov-card').count(), 0);
    const empty = await main.locator('.ov-empty').innerText();
    assert.match(empty, /No instances for you yet/);
    assert.ok(empty.includes(`Ask an admin of ${fx.orgName}`), empty);
    assert.ok(await main.locator(`.ov-empty a[href="/o/${fx.orgId}/teams"]`).count(), 'link to teams');
    await shot(t.page, 'user-empty');
    t.assertNoErrors();
    await t.close();
  });
});

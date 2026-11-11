// Personal area: Home (instances across orgs), Welcome (no org yet), the waitlist page.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import {
  Person, createRunningInstance, expectStatus, getSuperadmin, inviteAndJoin, newTenant, signUp, uniqueEmail, withRegistrationMode,
} from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();
const SHOTS = process.env.UI_SHOTS; // a directory: save screenshots of the views there
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const path = (page) => new URL(page.url()).pathname;

describe('personal: home, welcome, waitlist', { skip }, () => {
  after(closeBrowser);

  it('a tenant admin sees their running instance on Home with an Open link to its address', async () => {
    const { admin, orgId } = await newTenant('ui-home');
    const inst = await createRunningInstance(admin, orgId, { name: 'Home test instance' });
    for (const colorScheme of ['light', 'dark']) {
      const t = await pageAs(admin, { colorScheme });
      await t.page.goto('/');
      await settled(t.page);
      await t.page.waitForSelector(`[data-instance="${inst.id}"]`);
      const card = t.page.locator(`[data-instance="${inst.id}"]`);
      assert.match(await card.innerText(), /Home test instance/);
      assert.match(await card.innerText(), new RegExp(inst.host.replace(/\./g, '\\.')));
      const open = card.locator('a.btn', { hasText: 'Open' });
      assert.equal(await open.getAttribute('href'), inst.url);
      assert.match(await t.page.locator('h1').innerText(), /^Good (morning|afternoon|evening)/);
      assert.match(await t.page.locator('#home-sum').innerText(), /1 instance in /);
      assert.equal(await t.page.locator('.home-org').count(), 0, 'one org: no org groups');
      assert.ok(await t.page.locator(`.head a[href="/o/${orgId}/instances/new"]`).count(), 'admins get New instance');
      await shot(t.page, `home-${colorScheme}`);
      t.assertNoErrors();
      await t.close();
    }
    // phone width
    const t = await pageAs(admin, { viewport: { width: 390, height: 800 } });
    await t.page.goto('/');
    await settled(t.page);
    await t.page.waitForSelector(`[data-instance="${inst.id}"]`);
    await assertNoHorizontalScroll(t.page);
    await shot(t.page, 'home-phone');
    t.assertNoErrors();
    await t.close();
  });

  it('a person in two orgs sees a group per org, each linking to the org', async () => {
    const b = await newTenant('ui-home-b');
    // Someone with an org of their own (registered with a code) who is also invited into b's org.
    const { admin: member } = await newTenant('ui-home-m');
    await inviteAndJoin(b.admin, b.orgId, 'ui-home-m', { person: member });
    const t = await pageAs(member);
    await t.page.goto('/');
    await settled(t.page);
    await t.page.waitForSelector('.home-org');
    assert.equal(await t.page.locator('.home-org').count(), 2);
    assert.ok(await t.page.locator(`.home-org a[href="/o/${b.orgId}"]`).count(), 'group of the invited org');
    assert.match(await t.page.locator('#home-sum').innerText(), /across 2 orgs/);
    // tenant user with no team grants: a plain empty note, no New instance button for that org
    const group = t.page.locator('.home-org', { has: t.page.locator(`a[href="/o/${b.orgId}"]`) });
    assert.match(await group.innerText(), /None of your teams/);
    assert.equal(await group.locator('a[href$="/instances/new"]').count(), 0);
    await shot(t.page, 'home-two-orgs');
    // the org heading navigates into the org
    await t.page.click(`.home-org a[href="/o/${b.orgId}"]`);
    await t.page.waitForURL(`**/o/${b.orgId}`);
    t.assertNoErrors();
    await t.close();
  });

  it('a new user with no org lands on Welcome, creates an org and lands in it', async () => {
    const p = await signUp('ui-welcome');
    const t = await pageAs(p);
    await t.page.goto('/');
    await settled(t.page);
    assert.equal(path(t.page), '/welcome');
    assert.match(await t.page.locator('h1').innerText(), /^Welcome/);
    assert.match(await t.page.locator('#inv-list').innerText(), /No invitations/);
    await shot(t.page, 'welcome-light');
    // empty name: a field error, no request
    await t.page.click('#org-go');
    assert.match(await t.page.locator('#org-hint').innerText(), /Give the org a name/);
    assert.equal(await t.page.locator('#org-name').getAttribute('aria-invalid'), 'true');
    await t.page.fill('#org-name', 'Welcome Test Org');
    await t.page.click('#org-go');
    await t.page.waitForURL(/\/o\/[^/]+$/);
    const orgId = path(t.page).split('/')[2];
    const me = expectStatus(await p.get('/api/me'), 200).json();
    assert.ok(me.orgs.some((o) => o.id === orgId && o.role === 'tenant_admin'), 'became the tenant admin of the new org');
    // the shell knows the new org (me was reloaded)
    assert.match(await t.page.locator('#switch').innerText(), /Welcome Test Org/);
    t.assertNoErrors();
    await t.close();
  });

  it('pending invitations are listed on Welcome with an Accept link', async () => {
    const { admin, orgId, orgName } = await newTenant('ui-inv');
    const p = await signUp('ui-invitee');
    const inv = expectStatus(await admin.post(`/api/orgs/${orgId}/invitations`, { email: p.email, role: 'tenant_user' }), 201, 'invite').json();
    for (const colorScheme of ['light', 'dark']) {
      const t = await pageAs(p, { colorScheme });
      await t.page.goto('/welcome');
      await settled(t.page);
      const row = t.page.locator(`[data-invitation="${inv.id}"]`);
      assert.match(await row.innerText(), new RegExp(orgName.replace(/[.+]/g, '\\$&')));
      assert.match(await row.innerText(), /tenant user/);
      assert.equal(await row.locator('a', { hasText: 'Accept' }).getAttribute('href'), `/invite/${inv.id}`);
      await shot(t.page, `welcome-invitation-${colorScheme}`);
      if (colorScheme === 'light') {
        // Accept goes to the server-rendered invitation page
        await row.locator('a', { hasText: 'Accept' }).click();
        await t.page.waitForURL(`**/invite/${inv.id}`);
      }
      t.assertNoErrors();
      await t.close();
    }
  });

  it('a waitlisted account sees only Waiting for approval, with sign-out', async () => {
    const p = new Person(uniqueEmail('ui-waitlist'));
    await withRegistrationMode('waitlist', async () => {
      expectStatus(await p.signInWithCode(), 200, 'waitlist sign-up');
    });
    // light last: it signs out, which ends the session the pages share
    for (const colorScheme of ['dark', 'light']) {
      const t = await pageAs(p, { colorScheme });
      await t.page.goto('/');
      await settled(t.page);
      assert.equal(path(t.page), '/pending');
      assert.match(await t.page.locator('h1').innerText(), /Waiting for approval/);
      assert.equal(await t.page.locator('.sidebar').count(), 0, 'bare page');
      assert.ok(await t.page.locator('form[action="/sign-out"] button').count());
      await shot(t.page, `pending-${colorScheme}`);
      if (colorScheme === 'light') {
        await t.page.click('#pending-check');
        await t.page.waitForSelector('#toasts .toast');
        assert.equal(path(t.page), '/pending');
        await t.page.click('form[action="/sign-out"] button');
        await t.page.waitForURL('**/sign-in**');
      }
      t.assertNoErrors();
      await t.close();
    }
  });

  it('an active account is sent from /pending to Home; staff without orgs are pointed to the console', async () => {
    const sa = await getSuperadmin();
    const me = expectStatus(await sa.get('/api/me'), 200).json();
    const t = await pageAs(sa);
    await t.page.goto('/pending');
    await settled(t.page);
    assert.equal(path(t.page), '/');
    if (!me.orgs.length) {
      assert.ok(await t.page.locator('#main a[href="/platform"]').count(), 'link to the platform console');
      await shot(t.page, 'home-staff-no-org');
    }
    t.assertNoErrors();
    await t.close();
  });
});

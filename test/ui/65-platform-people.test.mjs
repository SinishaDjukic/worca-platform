// Platform console, people and system (ui/assets/js/views/platform-people.mjs): registration codes
// and the waitlist, user lookup and support actions, the two-person sign-in reset, the audit log,
// platform roles and the system page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { expectStatus, getSuperadmin, Person, signUp, uniqueEmail, withRegistrationMode, SUPERADMIN_EMAIL } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();

/** Waits for the toast to show text matching re. */
async function toastSays(page, re) {
  await page.waitForFunction((src) => {
    return [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent));
  }, re.source, { timeout: 15_000 });
}
async function lookUp(page, email) {
  await page.goto('/platform/users');
  await settled(page);
  await page.fill('#q', email);
  await page.click('#find button[type=submit]');
  await page.waitForSelector('#user-card, #user-miss');
}

describe('platform console: people and system', { skip }, () => {
  let sa;
  let staff; // an admin with a passkey session, for the second-person and rank rules
  before(async () => {
    sa = await getSuperadmin();
    staff = await signUp('ui-pp-staff', { passkey: true });
    expectStatus(await sa.post('/api/platform/roles', { email: staff.email, role: 'admin' }), 201, 'grant admin');
  });
  after(async () => {
    if (staff?.id) await sa.del(`/api/platform/roles/${staff.id}/admin`);
    await closeBrowser();
  });

  it('registration: a new code is shown once and appears in the list', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/registration');
    await settled(t.page);
    assert.ok(await t.page.locator('[data-mode="invite_code"], [data-mode="waitlist"], [data-mode="open"]').count() === 3);
    const note = `ui note ${Date.now()}`;
    await t.page.click('#new-code');
    await t.page.fill('#nc-uses', '3');
    await t.page.fill('#nc-days', '7');
    await t.page.fill('#nc-note', note);
    await t.page.click('#nc-go');
    await t.page.waitForSelector('#nc-code');
    const code = (await t.page.textContent('#nc-code')).trim();
    assert.match(code, /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/);
    assert.match(await t.page.textContent('.modal'), /won't see this code again/);
    await t.page.click('.modal [data-close]');
    await t.page.waitForSelector(`tr[data-code] >> text=${note}`);
    assert.equal(await t.page.locator(`text=${code}`).count(), 0, 'the code itself is never listed');
    // Revoke it again.
    await t.page.locator('tr', { hasText: note }).locator('[data-revoke]').click();
    await t.page.click('#pp-yes');
    await toastSays(t.page, /Code revoked/);
    await t.page.waitForFunction((n) => !document.body.textContent.includes(n), note);
    t.assertNoErrors();
    await t.close();
  });

  it('registration: an admin sees the mode but cannot change it', async () => {
    const t = await pageAs(staff);
    await t.page.goto('/platform/registration');
    await settled(t.page);
    assert.ok(await t.page.locator('[data-mode="open"]').isDisabled());
    assert.match(await t.page.textContent('#main'), /Only a superadmin can change the mode/);
    t.assertNoErrors();
    await t.close();
  });

  it('waitlist: a pending sign-up is approved', async () => {
    const pending = new Person(uniqueEmail('ui-pp-wait'));
    await withRegistrationMode('waitlist', async () => {
      expectStatus(await pending.signInWithCode(), 200, 'waitlist sign-up');
    });
    const me = await pending.me();
    assert.equal(me.user.status, 'pending');
    const t = await pageAs(sa);
    await t.page.goto('/platform/registration?tab=waitlist');
    await settled(t.page);
    const row = t.page.locator(`tr[data-pending="${me.user.id}"]`);
    await row.waitFor();
    assert.match(await row.textContent(), new RegExp(pending.email.replace(/[.+]/g, '\\$&')), 'the waitlist shows the address');
    await row.locator('[data-approve]').click();
    await toastSays(t.page, /Approved/);
    await t.page.waitForSelector(`tr[data-pending="${me.user.id}"]`, { state: 'detached' });
    assert.equal((await pending.me()).user.status, 'active');
    t.assertNoErrors();
    await t.close();
  });

  it('users: look up, disable and enable an account', async () => {
    const target = await signUp('ui-pp-target');
    const t = await pageAs(sa);
    await lookUp(t.page, 'not-a-user-' + Date.now() + '@e2e.test');
    assert.ok(await t.page.locator('#user-miss').count());
    await lookUp(t.page, target.email);
    const card = t.page.locator('#user-card');
    assert.match(await card.textContent(), new RegExp(target.email.replace(/[.+]/g, '\\$&')));
    assert.match(await card.textContent(), /Active/);
    await t.page.click('#u-disable');
    await t.page.click('#pp-yes');
    await toastSays(t.page, /Account disabled/);
    await t.page.waitForSelector('#user-card .pill.red');
    await t.page.waitForSelector('#u-enable');
    await t.page.click('#u-enable');
    await t.page.click('#pp-yes');
    await toastSays(t.page, /Account enabled/);
    await t.page.waitForSelector('#user-card .pill.green');
    t.assertNoErrors();
    await t.close();
  });

  it('users: a reset asked for by one staff member is approved by another; rank rule', async () => {
    const target = await signUp('ui-pp-reset');
    const a = await pageAs(staff);
    // Rank: an admin can't act on the superadmin.
    await lookUp(a.page, SUPERADMIN_EMAIL);
    await a.page.waitForSelector('#u-outranked');
    assert.equal(await a.page.locator('#u-disable').count(), 0);
    // The admin asks for the reset.
    await lookUp(a.page, target.email);
    await a.page.click('#u-reset');
    await a.page.click('#rs-go');
    assert.match(await a.page.locator('.field', { has: a.page.locator('#rs-why') }).locator('.field-error').innerText(), /Give a reason/, 'reason required');
    await a.page.fill('#rs-why', 'Lost both passkeys; verified by video call');
    await a.page.click('#rs-go');
    await a.page.waitForSelector('.modal >> text=Needs a second person');
    await a.page.click('.modal [data-close]');
    await settled(a.page);
    const own = a.page.locator('[data-request]', { hasText: target.email });
    await own.waitFor();
    assert.match(await own.textContent(), /You asked for this/);
    assert.equal(await own.locator('[data-approve-req]').count(), 0);
    a.assertNoErrors();
    await a.close();

    // The superadmin approves it.
    const t = await pageAs(sa);
    await t.page.goto('/platform/users');
    await settled(t.page);
    const row = t.page.locator('[data-request]', { hasText: target.email });
    await row.waitFor();
    assert.match(await row.textContent(), /verified by video call/);
    await row.locator('[data-approve-req]').click();
    assert.match(await t.page.textContent('.modal'), /every passkey and every session/);
    await t.page.click('#pp-yes');
    await toastSays(t.page, /Reset done/);
    await t.page.waitForFunction((e) => !document.querySelector('#requests') || !document.querySelector('#requests').textContent.includes(e), target.email);
    t.assertNoErrors();
    await t.close();
  });

  it('audit: category and action filters, CSV export', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/audit');
    await settled(t.page);
    await t.page.waitForSelector('#audit-rows tr');
    await t.page.click('[data-cat="security"]');
    await t.page.waitForURL(/category=security/);
    await settled(t.page);
    assert.equal(await t.page.getAttribute('[data-cat="security"]', 'aria-pressed'), 'true');
    await t.page.selectOption('#f-action', 'platform.');
    await t.page.waitForURL(/action=platform\./);
    await settled(t.page);
    const actions = await t.page.$$eval('#audit-rows tr .mono:first-child', (els) => els.map((e) => e.textContent));
    assert.ok(actions.length > 0, 'the superadmin granted a role above, so there is a platform.role_granted entry');
    for (const a of actions) assert.match(a, /^platform\./);
    const [download] = await Promise.all([t.page.waitForEvent('download'), t.page.click('#csv')]);
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv.split('\r\n')[0], /^time,actor,actor_id,role,action/);
    assert.equal(csv.trim().split('\r\n').length, actions.length + 1);
    await t.page.click('#f-clear');
    await t.page.waitForURL((u) => !u.search);
    t.assertNoErrors();
    await t.close();
  });

  it('roles: grant and revoke a role', async () => {
    const person = await signUp('ui-pp-role');
    const t = await pageAs(sa);
    await t.page.goto('/platform/roles');
    await settled(t.page);
    await t.page.click('#grant');
    await t.page.fill('#g-mail', 'nobody-' + Date.now() + '@e2e.test');
    await t.page.click('#g-go');
    // The address is the problem: under the field.
    const mailErr = t.page.locator('.field', { has: t.page.locator('#g-mail') }).locator('.field-error');
    await mailErr.waitFor();
    assert.match(await mailErr.innerText(), /No account with that address/);
    await t.page.fill('#g-mail', person.email);
    await t.page.check('input[name="g-role"][value="support"]');
    await t.page.click('#g-go');
    await toastSays(t.page, /is now Support/);
    const row = t.page.locator(`[data-binding="${person.id}:support"]`);
    await row.waitFor();
    // Own row has no remove button.
    const meId = (await sa.me()).user.id;
    assert.equal(await t.page.locator(`[data-binding="${meId}:superadmin"] [data-revoke-role]`).count(), 0);
    await row.locator('[data-revoke-role]').click();
    await t.page.click('#pp-yes');
    await toastSays(t.page, /Role removed/);
    await t.page.waitForSelector(`[data-binding="${person.id}:support"]`, { state: 'detached' });
    t.assertNoErrors();
    await t.close();
  });

  it('system: mail, providers and keys; the master key only for superadmins', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/system');
    await settled(t.page);
    assert.match(await t.page.textContent('#mail'), /\/ 100/);
    assert.match(await t.page.textContent('#mail'), /\/ 3,000/);
    assert.equal(await t.page.locator('#mail-days .pp-day').count(), 14);
    const prov = await t.page.textContent('#providers');
    assert.match(prov, /Fake compute · compute/);
    assert.match(prov, /Fake providers/);
    assert.match(prov, /Bot protection/);
    assert.ok(await t.page.locator('#master').count());
    assert.match(await t.page.textContent('#master'), /MASTER_KEY_PREVIOUS/);
    assert.match(await t.page.textContent('#keys'), /org keys/);
    t.assertNoErrors();
    await t.close();

    const a = await pageAs(staff);
    await a.page.goto('/platform/system');
    await settled(a.page);
    assert.equal(await a.page.locator('#master').count(), 0);
    assert.ok(await a.page.locator('#keys').count());
    assert.equal(await a.page.locator('.sidebar a[href="/platform/roles"]').count(), 0);
    await a.page.goto('/platform/roles');
    await settled(a.page);
    assert.equal(new URL(a.page.url()).pathname, '/platform', 'admins are sent away from roles');
    a.assertNoErrors();
    await a.close();
  });

  it('phone width: user lookup without sideways scroll', async () => {
    const t = await pageAs(sa, { viewport: { width: 390, height: 800 } });
    await lookUp(t.page, staff.email);
    await assertNoHorizontalScroll(t.page);
    await t.page.goto('/platform/audit');
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    await t.page.goto('/platform/system');
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    await t.page.goto('/platform/registration?all=1');
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    t.assertNoErrors();
    await t.close();
  });
});

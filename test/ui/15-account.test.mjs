// Account area: profile, passkeys (virtual authenticator), linked accounts, devices, export and
// account deletion.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { Person, expectStatus, newTenant, signUp } from '../e2e/lib/flows.mjs';
import { addVirtualAuthenticator, assertNoHorizontalScroll, closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

/** Another session of the same account, signed in by email code. */
async function secondSession(person) {
  const other = new Person(person.email, `${person.email.split('@')[0]}-2`);
  expectStatus(await other.signInWithCode(), 200, 'second sign-in');
  return other;
}

describe('account', { skip }, () => {
  after(closeBrowser);

  it('profile: renames the account; the sidebar follows', async () => {
    const p = await signUp('ui-acct-name');
    const t = await pageAs(p);
    await t.page.goto('/account');
    await settled(t.page);
    assert.equal(await t.page.locator('#p-mail').inputValue(), p.email);
    assert.ok(await t.page.locator('#p-save').isDisabled(), 'nothing to save yet');
    await t.page.fill('#p-name', 'Maja Horvat');
    await t.page.click('#p-save');
    // The save reports on its button, as in worca: "✓ Saved" for 2 s.
    await t.page.locator('#p-save.is-done', { hasText: 'Saved' }).waitFor();
    await t.page.waitForSelector('.sidebar .ctx b:text("Maja Horvat")');
    assert.equal((await p.me()).user.name, 'Maja Horvat');
    // No Google or Microsoft credentials locally: nothing to link, the email code is mentioned.
    assert.match(await t.page.locator('#ln-list').innerText(), /aren't available/);
    assert.equal(await t.page.locator('[data-link]').count(), 0);
    t.assertNoErrors();
    await t.close();
  });

  it('passkeys: add one, rename it after a passkey step-up, remove the last one with a warning', async () => {
    const p = await signUp('ui-acct-pk');
    const t = await pageAs(p);
    await addVirtualAuthenticator(t.page);
    await t.page.goto('/account');
    await settled(t.page);
    assert.match(await t.page.locator('#pk-list').innerText(), /No passkeys yet/);

    // The first passkey can come from the email-code session.
    await t.page.click('#pk-add');
    await t.page.fill('#pkn-name', 'Test laptop');
    await t.page.click('#pkn-go');
    await t.page.waitForSelector('#pk-list .row:has-text("Test laptop")');
    const row = t.page.locator('#pk-list .row', { hasText: 'Test laptop' });
    assert.match(await row.innerText(), /not used yet/);
    assert.equal((await p.me()).signIn.passkeys, 1);

    // Renaming now needs a passkey session: the step-up dialog signs in with the virtual key.
    await row.locator('[data-rename]').click();
    await t.page.fill('#pkn-name', 'Work laptop');
    await t.page.click('#pkn-go');
    await t.page.waitForSelector('#su-go');
    await t.page.click('#su-go');
    await t.page.waitForSelector('#pk-list .row:has-text("Work laptop")');
    // The step-up signed this browser in with the passkey, so it now shows as used.
    assert.doesNotMatch(await t.page.locator('#pk-list .row').first().innerText(), /not used yet/);

    // Removing the only passkey warns first.
    await t.page.locator('#pk-list [data-remove]').click();
    await t.page.waitForSelector('.modal .banner:has-text("only passkey")');
    await t.page.click('#cf-go');
    await t.page.waitForSelector('#pk-list .empty');
    t.assertNoErrors();
    await t.close();
  });

  it('devices: lists every session, signs out one, then all others', async () => {
    const p = await signUp('ui-acct-sess');
    const s2 = await secondSession(p);
    const s3 = await secondSession(p);
    const t = await pageAs(p);
    await t.page.goto('/account/sessions');
    await settled(t.page);
    assert.equal(await t.page.locator('#ss-list .row').count(), 3);
    const current = t.page.locator('#ss-list .row[data-session="current"]');
    assert.match(await current.innerText(), /this device[\s\S]*Email code[\s\S]*This one/);
    assert.equal(await current.locator('[data-signout]').count(), 0, 'the current session has no sign-out button');
    assert.doesNotMatch(await t.page.locator('#ss-list').innerText(), /location/i);

    await t.page.locator('#ss-list [data-signout]').first().click();
    await t.page.waitForFunction(() => document.querySelectorAll('#ss-list .row').length === 2);
    const signedIn = [await s2.me(), await s3.me()].filter(Boolean).length;
    assert.equal(signedIn, 1, 'exactly one of the other sessions ended');

    await t.page.click('#ss-others');
    await t.page.click('#cf-go');
    await t.page.waitForFunction(() => document.querySelectorAll('#ss-list .row').length === 1);
    assert.equal(await s2.me(), null);
    assert.equal(await s3.me(), null);
    assert.equal(await t.page.locator('#ss-others').count(), 0);
    assert.ok(await p.me(), 'this device stays signed in');
    t.assertNoErrors();
    await t.close();
  });

  it('your data: downloads the export as a JSON file', async () => {
    const p = await signUp('ui-acct-export');
    const t = await pageAs(p);
    await t.page.goto('/account/data');
    await settled(t.page);
    assert.match(await t.page.locator('.kv').innerText(), new RegExp(p.email.replace(/[.+]/g, '\\$&')));
    const [download] = await Promise.all([t.page.waitForEvent('download'), t.page.click('#dt-export')]);
    assert.equal(download.suggestedFilename(), 'worca-account-export.json');
    const data = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(data.profile.email, p.email);
    assert.ok(Array.isArray(data.orgs));
    t.assertNoErrors();
    await t.close();
  });

  it('delete account: typed email, then "check your email"', async () => {
    const p = await signUp('ui-acct-del');
    const t = await pageAs(p);
    await t.page.goto('/account/data');
    await settled(t.page);
    await t.page.click('#del-me');
    assert.ok(await t.page.locator('#pa-go').isDisabled());
    await t.page.fill('#pa-name', p.email);
    await t.page.click('#pa-go');
    await t.page.waitForSelector('.modal h2:text("Check your email")');
    assert.ok(await p.me(), 'nothing happens before the emailed link is confirmed');
    t.assertNoErrors();
    await t.close();
  });

  it('delete account: the last admin of an org is told what to do first', async () => {
    const { admin, orgId } = await newTenant('ui-acct-lastadm');
    const t = await pageAs(admin);
    await t.page.goto('/account/data');
    await settled(t.page);
    await t.page.click('#del-me');
    await t.page.fill('#pa-name', admin.email);
    await t.page.click('#pa-go');
    await t.page.waitForSelector(".modal h2:text(\"Your account can't be deleted yet\")");
    assert.ok(await t.page.locator(`.modal a[href="/o/${orgId}/members"]`).count());
    t.assertNoErrors();
    await t.close();
  });

  it('phone width: account and devices pages fit without sideways scrolling', async () => {
    const { admin } = await newTenant('ui-acct-phone'); // has a passkey: rows with two buttons
    await secondSession(admin);
    const t = await pageAs(admin, { viewport: { width: 390, height: 800 } });
    for (const path of ['/account', '/account/sessions', '/account/data']) {
      await t.page.goto(path);
      await settled(t.page);
      await assertNoHorizontalScroll(t.page);
    }
    t.assertNoErrors();
    await t.close();
  });
});

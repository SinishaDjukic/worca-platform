// Newsletter (D70): the /newsletter page (confirm, preferences, unsubscribe, "email me a link"),
// the account page's Newsletter card, and the console's Newsletter section on Releases.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp, APP_ORIGIN } from '../e2e/lib/config.mjs';
import { expectStatus, getSuperadmin, signUp, uniqueEmail } from '../e2e/lib/flows.mjs';
import { request } from '../e2e/lib/http.mjs';
import { extractLink, waitForMail } from '../e2e/lib/mail.mjs';
import { assertNoHorizontalScroll, closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

const subscribe = (email, releases = 'minor', product = true) =>
  request(`${APP_ORIGIN}/api/public/newsletter/subscribe`, { method: 'POST', body: { email, releases, product, source: 'ui-test' } });

describe('newsletter', { skip }, () => {
  after(closeBrowser);

  it('/newsletter: confirm from the mail, change preferences, unsubscribe from everything', async () => {
    const email = uniqueEmail('ui-nl');
    expectStatus(await subscribe(email), 202, 'subscribe');
    const mail = await waitForMail(email, { match: (m) => /Confirm your subscription/.test(m.subject) });
    const link = extractLink(mail, '/newsletter#c=');

    const t = await pageAs(null);
    await t.page.goto(link);
    // Loading the page confirms nothing; the button does.
    await t.page.locator('#nl-confirm-go').waitFor({ state: 'visible' });
    await t.page.locator('#nl-confirm-go').click();
    await t.page.locator('#nl-prefs').waitFor({ state: 'visible' });
    assert.equal(await t.page.locator('#nl-title').textContent(), 'You are subscribed');
    assert.ok(await t.page.locator('input[name="releases"][value="minor"]').isChecked());
    assert.ok(await t.page.locator('#nl-product').isChecked());
    assert.match(new URL(t.page.url()).hash, /^#t=/, 'the confirm token is swapped for the manage token');

    await t.page.check('input[name="releases"][value="rc"]');
    await t.page.uncheck('#nl-product');
    await t.page.click('#nl-save');
    await t.page.locator('#nl-status', { hasText: 'Saved.' }).waitFor();
    assert.match(await t.page.locator('#nl-status').textContent(), /release candidates/);

    // Nothing chosen: refused on the page.
    await t.page.check('input[name="releases"][value="none"]');
    await t.page.click('#nl-save');
    // One rule for the choices: the problem shows under them, as in the console.
    assert.match(await t.page.locator('#nl-prefs .field-error').textContent(), /Choose something/);
    assert.equal(await t.page.locator('#nl-product').getAttribute('aria-invalid'), 'true');

    await t.page.click('#nl-unsub-open');
    await t.page.click('#nl-unsub-go');
    await t.page.locator('#nl-title', { hasText: 'You are unsubscribed' }).waitFor();
    assert.equal(await t.page.locator('#nl-prefs').isVisible(), false);
    await assertNoHorizontalScroll(t.page);
    t.assertNoErrors();
    await t.close();

    // Unsubscribing from everything kills the confirmation link too; the page offers a fresh link.
    const t2 = await pageAs(null);
    await t2.page.goto(link);
    await t2.page.click('#nl-confirm-go');
    await t2.page.locator('#nl-link').waitFor({ state: 'visible' });
    t2.assertNoErrors();
    await t2.close();
  });

  it('/newsletter without a token: "email me a manage link"', async () => {
    const t = await pageAs(null, { viewport: { width: 390, height: 800 } });
    await t.page.goto('/newsletter');
    await t.page.locator('#nl-link').waitFor({ state: 'visible' });
    await t.page.fill('#nl-email', uniqueEmail('ui-nl-nobody'));
    await t.page.click('#nl-link button[type="submit"]');
    await t.page.locator('#nl-status', { hasText: 'is subscribed, a link' }).waitFor();
    await assertNoHorizontalScroll(t.page);
    t.assertNoErrors();
    await t.close();
  });

  it('account: the Newsletter card subscribes the account address directly, then unsubscribes', async () => {
    const p = await signUp('ui-nl-acct');
    const t = await pageAs(p);
    await t.page.goto('/account');
    await settled(t.page);
    assert.equal((await t.page.locator('#nl-state').textContent()).trim(), 'Not subscribed');
    await t.page.check('input[name="nl-releases"][value="micro"]');
    await t.page.click('#nl-save');
    await t.page.locator('#nl-state', { hasText: /^Subscribed$/ }).waitFor();
    assert.ok(await t.page.locator('input[name="nl-releases"][value="micro"]').isChecked());
    const me = await p.get('/api/me/newsletter');
    assert.deepEqual(me.json(), { subscribed: true, status: 'active', releases: 'micro', product: true });

    await t.page.click('#nl-off');
    await t.page.locator('#nl-state', { hasText: 'Not subscribed' }).waitFor();
    t.assertNoErrors();
    await t.close();
  });

  it('console: Releases shows the Newsletter counts and issues to admins', async () => {
    const sa = await getSuperadmin();
    const t = await pageAs(sa);
    await t.page.goto('/platform/releases');
    await settled(t.page);
    await t.page.locator('#pc-newsletter').waitFor();
    assert.match(await t.page.locator('#pc-newsletter').textContent(), /active subscriber/);
    t.assertNoErrors();
    await t.close();
  });
});

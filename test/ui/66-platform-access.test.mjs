// Access requests (D69): the confirmation page a requester opens from the mail, and the console
// view (ui/assets/js/views/platform-access.mjs) where a superadmin grants or declines. The grant
// mail's link opens the sign-in page with the code filled in.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { expectStatus, getSuperadmin, Person, uniqueEmail, withRegistrationMode } from '../e2e/lib/flows.mjs';
import { extractLink, mailMark, waitForMail } from '../e2e/lib/mail.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();

async function toastSays(page, re) {
  await page.waitForFunction((src) => {
    return [...document.querySelectorAll('#toasts .toast')].some((t) => new RegExp(src).test(t.textContent));
  }, re.source, { timeout: 15_000 });
}

/** Sends the website form as `person` and confirms it on the page the mail links to. */
async function requestAndConfirm(person, useCase) {
  const before = await mailMark(person.email);
  expectStatus(await person.post('/api/public/access-requests', { email: person.email, useCase, company: 'UI Test Co', source: 'hosted' }), 202, 'access request');
  const mail = await waitForMail(person.email, { after: before, match: (m) => /Confirm your request/.test(m.subject) });
  const link = extractLink(mail, '/access-request#t=');
  const t = await pageAs(null);
  await t.page.goto(link);
  await t.page.waitForSelector('#ar-confirm button:not([disabled])');
  assert.ok(!t.page.url().includes('#t='), 'the token is dropped from the address bar');
  await t.page.click('#ar-confirm button');
  await t.page.waitForFunction(() => /request is confirmed/.test(document.querySelector('#ar-lead')?.textContent || ''));
  t.assertNoErrors();
  await t.close();
}

describe('platform console: access requests', { skip }, () => {
  after(closeBrowser);

  it('a confirmed request is listed and granted; the mailed link fills in the sign-up code', async () => {
    const sa = await getSuperadmin();
    const requester = new Person(uniqueEmail('ui-ar-grant'));
    const useCase = `UI grant ${Date.now()}`;
    await requestAndConfirm(requester, useCase);

    const t = await pageAs(sa);
    await t.page.goto('/platform/access-requests');
    await settled(t.page);
    await t.page.waitForSelector('#ar-funnel');
    const row = t.page.locator('tr[data-request]', { hasText: useCase });
    await row.waitFor();
    assert.match(await row.textContent(), /UI Test Co/);
    await assertNoHorizontalScroll(t.page);
    const before = await mailMark(requester.email);
    await row.locator('[data-grant]').click();
    await t.page.fill('#ag-days', '7');
    await t.page.fill('#ag-msg', 'Welcome from the UI test');
    await t.page.click('#ag-go');
    await toastSays(t.page, /Granted/);
    await t.page.waitForSelector(`tr[data-request] >> text=${useCase}`, { state: 'detached' });
    t.assertNoErrors();
    await t.close();

    const granted = await waitForMail(requester.email, { after: before, match: (m) => /Your access to hosted worca/i.test(m.subject) });
    assert.match(granted.text, /Welcome from the UI test/);
    const link = extractLink(granted, '/sign-in#code=');
    const code = decodeURIComponent(link.split('#code=')[1]);
    await withRegistrationMode('invite_code', async () => {
      const s = await pageAs(null);
      await s.page.goto(link);
      await s.page.waitForSelector('#signup-code');
      assert.equal(await s.page.inputValue('#signup-code'), code);
      assert.ok(!s.page.url().includes('#code='), 'the code is dropped from the address bar');
      s.assertNoErrors();
      await s.close();
      // Only the requester's address can use it.
      const other = new Person(uniqueEmail('ui-ar-other'));
      assert.equal((await other.signInWithCode({ signupCode: code })).status, 403);
      expectStatus(await requester.signInWithCode({ signupCode: code }), 200, 'sign-up with the granted code');
    });
    const all = (await sa.get('/api/platform/access-requests?status=all')).json();
    assert.equal(all.requests.find((r) => r.email === requester.email)?.status, 'joined');
  });

  it('decline, with the email note switched off', async () => {
    const sa = await getSuperadmin();
    const requester = new Person(uniqueEmail('ui-ar-decline'));
    const useCase = `UI decline ${Date.now()}`;
    await requestAndConfirm(requester, useCase);
    const t = await pageAs(sa);
    await t.page.goto('/platform/access-requests');
    await settled(t.page);
    const row = t.page.locator('tr[data-request]', { hasText: useCase });
    await row.waitFor();
    await row.locator('[data-decline]').click();
    await t.page.uncheck('#ad-notify');
    assert.ok(await t.page.locator('#ad-msg').isDisabled());
    await t.page.click('#ad-go');
    await toastSays(t.page, /No email was sent/);
    await t.page.waitForSelector(`tr[data-request] >> text=${useCase}`, { state: 'detached' });
    await t.page.click('[data-tab="/platform/access-requests?status=all"]');
    await t.page.locator('tr[data-request]', { hasText: useCase }).locator('text=Declined').waitFor();
    t.assertNoErrors();
    await t.close();
  });
});

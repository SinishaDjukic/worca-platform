// Server-rendered pages in the app's look: /sign-in (email-code sign-in through the page), the
// invitation page, a D30 confirmation page, /sign-out, and the gate's own pages on instance hosts.
// Screenshots (light and dark) go to UI_SHOTS_DIR when set.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { skipUnlessUp, APP_ORIGIN, GATE_PORT, INSTANCE_DOMAIN } from '../e2e/lib/config.mjs';
import { Person, expectStatus, newTenant, signUp, uniqueEmail } from '../e2e/lib/flows.mjs';
import { extractCode, extractLink, mailMark, waitForMail } from '../e2e/lib/mail.mjs';
import { assertNoHorizontalScroll, closeBrowser, pageAs } from './lib.mjs';

const skip = await skipUnlessUp();
const SHOTS = process.env.UI_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** Opens `url` in light and dark, runs `check` on each, screenshots both. */
async function bothSchemes(person, url, name, check) {
  for (const colorScheme of ['light', 'dark']) {
    const t = await pageAs(person, { colorScheme });
    await t.page.goto(url);
    await check(t.page, colorScheme);
    await shot(t.page, `${name}-${colorScheme}`);
    t.assertNoErrors();
    await t.close();
  }
}

/** The stylesheet really applied: the card is a panel with the app's radius, the logo is masked. */
async function assertStyled(page) {
  const s = await page.evaluate(() => {
    const card = document.querySelector('.card');
    const logo = document.querySelector('.logo');
    return {
      radius: card && getComputedStyle(card).borderTopLeftRadius,
      logoW: logo ? logo.getBoundingClientRect().width : 0,
      font: getComputedStyle(document.body).fontFamily,
    };
  });
  assert.equal(s.radius, '14px', 'card styled');
  assert.ok(s.logoW > 40, `logo rendered (${s.logoW}px)`);
  assert.match(s.font, /Poppins|system-ui/);
}

describe('server-rendered pages', { skip }, () => {
  after(closeBrowser);

  it('/sign-in renders in both schemes, with the sign-up code explained', async () => {
    await bothSchemes(null, '/sign-in?next=/', 'sign-in', async (page) => {
      await assertStyled(page);
      assert.match(await page.locator('h1').textContent(), /^Sign in to worca$/i);
      for (const id of ['#email', '#email-step', '#sso', '#passkey', '#status']) assert.equal(await page.locator(id).count(), 1, id);
      assert.equal(await page.locator('#code-step').isVisible(), false, 'code step hidden at first');
      if (await page.locator('#signup-code').count()) {
        assert.match(await page.locator('#signup-code-hint').textContent(), /sign-up code|waitlist/i);
        assert.equal(await page.locator('label[for="signup-code"]').count(), 1);
      }
      assert.equal(await page.locator(`a[href="https://example.com/hosted/"]`).count(), 1, '"what is this" link');
    });
  });

  it('phone width: the sign-in card fits without sideways scroll', async () => {
    const t = await pageAs(null, { viewport: { width: 390, height: 800 } });
    await t.page.goto('/sign-in');
    await assertNoHorizontalScroll(t.page);
    await shot(t.page, 'sign-in-phone');
    t.assertNoErrors();
    await t.close();
  });

  it('an empty email is refused on the page, without a request', async () => {
    const t = await pageAs(null);
    await t.page.goto('/sign-in');
    await t.page.click('#email-step button[type="submit"]');
    // A field's problem shows under it, as in the console.
    const emailErr = t.page.locator('.field', { has: t.page.locator('#email') }).locator('.field-error');
    await emailErr.waitFor();
    assert.match(await emailErr.textContent(), /enter your email/i);
    assert.equal(await t.page.locator('#email').getAttribute('aria-invalid'), 'true');
    t.assertNoErrors();
    await t.close();
  });

  it('email-code sign-in through the page lands on the app', async () => {
    const p = await signUp('ui-pages'); // existing account: no sign-up code needed
    const t = await pageAs(null);
    await t.page.goto('/sign-in?next=%2Faccount');
    const before = await mailMark(p.email);
    await t.page.fill('#email', p.email);
    await t.page.click('#email-step button[type="submit"]');
    await t.page.waitForSelector('#code-step:not([hidden])');
    assert.match(await t.page.locator('#status').textContent(), /we sent a code/i);
    await shot(t.page, 'sign-in-code-step');
    const mail = await waitForMail(p.email, { after: before, match: (m) => /\b\d{6}\b/.test(`${m.subject}\n${m.text}`) });
    await t.page.fill('#otp', extractCode(mail));
    await Promise.all([t.page.waitForURL(`${APP_ORIGIN}/account`), t.page.click('#code-step button[type="submit"]')]);
    await t.page.waitForSelector('#main');
    t.assertNoErrors();
    await t.close();
  });

  it('a wrong code shows an error and keeps the code step', async () => {
    const p = await signUp('ui-pages-bad');
    const t = await pageAs(null);
    await t.page.goto('/sign-in');
    await t.page.fill('#email', p.email);
    await t.page.click('#email-step button[type="submit"]');
    await t.page.waitForSelector('#code-step:not([hidden])');
    await t.page.fill('#otp', '000000');
    await t.page.click('#code-step button[type="submit"]');
    // The code is the problem: under the code field.
    const otpErr = t.page.locator('.field', { has: t.page.locator('#otp') }).locator('.field-error');
    await otpErr.waitFor();
    assert.match(await otpErr.textContent(), /code isn't right/);
    assert.equal(await t.page.locator('#otp').getAttribute('aria-invalid'), 'true');
    assert.ok(await t.page.locator('#code-step').isVisible());
    await t.page.click('#restart');
    assert.ok(await t.page.locator('#email-step').isVisible(), 'back to the email step');
    await t.close();
  });

  it('a new address without a sign-up code is sent back to the code field (invite_code mode)', async (ctx) => {
    const t = await pageAs(null);
    await t.page.goto('/sign-in');
    if (!(await t.page.locator('#signup-code').count())) return ctx.skip('registration is open locally');
    const email = uniqueEmail('ui-nocode');
    const before = await mailMark(email);
    await t.page.fill('#email', email);
    await t.page.click('#email-step button[type="submit"]');
    await t.page.waitForSelector('#code-step:not([hidden])');
    const mail = await waitForMail(email, { after: before });
    await t.page.fill('#otp', extractCode(mail));
    await t.page.click('#code-step button[type="submit"]');
    // A missing sign-up code shows under that field; anything else in the red status box.
    const shown = t.page.locator('#status.err, .field:has(#signup-code) .field-error').first();
    await shown.waitFor();
    const text = await shown.textContent();
    if (/sign-up code/i.test(text)) {
      assert.ok(await t.page.locator('#email-step').isVisible(), 'email step shown again');
      assert.equal(await t.page.evaluate(() => document.activeElement?.id), 'signup-code');
      assert.equal(await t.page.locator('#signup-code').getAttribute('aria-invalid'), 'true');
    }
    await shot(t.page, 'sign-in-code-required');
    await t.close();
  });

  it('D23: a signed-in person asked for another method sees the page, not a redirect', async () => {
    const p = await signUp('ui-pages-d23');
    await bothSchemes(p, '/sign-in?next=%2F&methods=sso,passkey', 'sign-in-again', async (page) => {
      assert.equal(new URL(page.url()).pathname, '/sign-in');
      assert.match(await page.locator('#policy-note').textContent(), /single sign-on or a passkey/);
    });
    const t = await pageAs(p);
    await t.page.goto('/sign-in?next=%2Faccount');
    assert.equal(new URL(t.page.url()).pathname, '/account', 'without methods: straight on');
    await t.close();
  });

  it('invitation page', async () => {
    const { admin, orgId, orgName } = await newTenant('ui-pages-inv');
    const p = new Person(uniqueEmail('ui-invitee'));
    const before = await mailMark(p.email);
    expectStatus(await admin.post(`/api/orgs/${orgId}/invitations`, { email: p.email, role: 'tenant_user' }), 201, 'invite');
    const link = extractLink(await waitForMail(p.email, { after: before, match: (m) => /invit/i.test(m.subject) }), '/invite/');
    expectStatus(await p.signInWithCode(), 200, 'invitee sign-in');
    await bothSchemes(p, new URL(link).pathname, 'invite', async (page) => {
      await assertStyled(page);
      assert.equal(await page.locator('h1').textContent(), `Join ${orgName}`);
      assert.equal(await page.locator('form[method="post"] button[type="submit"]').count(), 1);
    });
    const t = await pageAs(p);
    await t.page.goto(new URL(link).pathname);
    await Promise.all([t.page.waitForURL(`${APP_ORIGIN}/`), t.page.click('form[method="post"] button[type="submit"]')]);
    const me = await p.me();
    assert.ok(me.orgs.some((o) => o.id === orgId), 'joined');
    t.assertNoErrors();
    await t.close();
  });

  it('confirmation page (D30) under its strict CSP', async () => {
    const t0 = await newTenant('ui-pages-conf');
    const before = await mailMark(t0.admin.email);
    expectStatus(await t0.admin.del(`/api/orgs/${t0.orgId}`, { confirmName: t0.orgName }), 202, 'start org delete');
    const link = extractLink(await waitForMail(t0.admin.email, { after: before, match: (m) => /confirm/i.test(m.subject) }), '/confirm/');
    const u = new URL(link);
    await bothSchemes(t0.admin, u.pathname + u.search, 'confirm', async (page) => {
      await assertStyled(page);
      assert.equal(await page.locator('form[method="post"] input[name="t"]').count(), 1);
      assert.equal(await page.locator('button.solid-danger').count(), 1);
    });
    // Signed out: a sign-in link that comes back here.
    const anon = await pageAs(null);
    const res = await anon.page.goto(u.pathname + u.search);
    assert.equal(res.status(), 401);
    assert.match(res.headers()['content-security-policy'], /default-src 'none'; style-src 'self'/);
    const href = await anon.page.locator('a.btn.primary').getAttribute('href');
    assert.match(href, /^\/sign-in\?next=%2Fconfirm%2F/);
    await assertStyled(anon.page);
    anon.assertNoErrors();
    await anon.close();
  });

  // The page's Referrer-Policy decides what Origin the browser sends with the form: under
  // `no-referrer` it is `null`, which the origin check refuses (the bug this guards against).
  it('confirmation page: pressing Confirm in a browser completes the action', async () => {
    const p = await signUp('ui-pages-confirm');
    const before = await mailMark(p.email);
    expectStatus(await p.del('/api/me', { confirmName: p.email }), 202, 'start account delete');
    const link = extractLink(await waitForMail(p.email, { after: before, match: (m) => /confirm/i.test(m.subject) }), '/confirm/');
    const t = await pageAs(p);
    const u = new URL(link);
    await t.page.goto(u.pathname + u.search);
    const posted = t.page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/confirm/'));
    const [res] = await Promise.all([t.page.waitForNavigation(), t.page.click('form[method="post"] button[type="submit"]')]);
    assert.equal((await posted).headers().origin, APP_ORIGIN, 'the form posts with the app origin, not null');
    assert.equal(res.status(), 200, await t.page.content());
    assert.equal(await t.page.locator('h1').textContent(), 'Done');
    assert.equal((await p.get('/api/me')).status, 401, 'account deleted');
    t.assertNoErrors();
    await t.close();
  });

  it('sign-out page', async () => {
    const p = await signUp('ui-pages-out');
    await bothSchemes(p, '/sign-out', 'sign-out', async (page) => {
      await assertStyled(page);
    });
    const t = await pageAs(p);
    await t.page.goto('/sign-out');
    await Promise.all([t.page.waitForURL(/\/sign-in$/), t.page.click('form[method="post"] button[type="submit"]')]);
    await t.close();
  });

  it('gate: unknown host gets the branded 404', async () => {
    const url = `http://nobody${Date.now().toString(36)}.${INSTANCE_DOMAIN}:${GATE_PORT}/`;
    await bothSchemes(null, url, 'gate-no-instance', async (page) => {
      await assertStyled(page);
      assert.equal(await page.locator('h1').textContent(), 'No instance here');
      assert.equal(await page.locator(`a[href="${APP_ORIGIN}"]`).count(), 1, 'link to the app');
      assert.equal(await page.locator('a[href="https://example.com/hosted/"]').count() >= 1, true);
    });
    const t = await pageAs(null, { viewport: { width: 390, height: 800 } });
    await t.page.goto(url);
    await assertNoHorizontalScroll(t.page);
    await t.close();
  });

  it('gate: the cookie recovery page', async () => {
    const host = `nobody${Date.now().toString(36)}.${INSTANCE_DOMAIN}`;
    for (const colorScheme of ['light', 'dark']) {
      const t = await pageAs(null, { colorScheme });
      await t.ctx.addCookies([1, 2, 3].map((i) => ({ name: `junk${i}`, value: 'x'.repeat(3500), domain: host, path: '/' })));
      const res = await t.page.goto(`http://${host}:${GATE_PORT}/`);
      assert.equal(res.status(), 400);
      await assertStyled(t.page);
      await shot(t.page, `gate-cookies-${colorScheme}`);
      t.assertNoErrors();
      await t.close();
    }
  });
});

// Browser tests of the web UI (ui/), against the local stack (`npm run dev`), with Playwright.
// People are set up through the API helpers of the e2e suite (test/e2e/lib/flows.mjs); their
// session cookies are then copied into a browser context, so a test starts signed in.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { APP_ORIGIN } from '../e2e/lib/config.mjs';

export { APP_ORIGIN };

let browser = null;
export async function getBrowser() {
  browser ??= await chromium.launch({ headless: process.env.UI_HEADED !== '1' });
  return browser;
}
export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

/**
 * A page signed in as `person` (an e2e Person). Collects uncaught page errors and console errors
 * in `errors`; call `assertNoErrors()` at the end of a test.
 * Options: viewport ({ width, height }), webauthn (true: a CDP virtual authenticator, see below).
 */
export async function pageAs(person, { viewport = { width: 1280, height: 860 }, colorScheme = 'light' } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({ baseURL: APP_ORIGIN, viewport, colorScheme });
  const host = new URL(APP_ORIGIN).hostname;
  if (person) {
    const cookies = person.browser.jar.cookies
      .filter((c) => c.domain === host || (!c.hostOnly && host.endsWith(c.domain)))
      .map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: 'Lax',
        expires: c.expires ? Math.floor(c.expires / 1000) : -1,
      }));
    await ctx.addCookies(cookies);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return {
    page, ctx, errors,
    assertNoErrors: () => assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`),
    close: () => ctx.close(),
  };
}

/** Adds a CDP virtual authenticator (platform, resident keys, user verification) to the page. */
export async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

/** Waits until the app shell finished rendering a view (no loading spinner left in #main). */
export async function settled(page) {
  await page.waitForFunction(() => {
    const main = document.querySelector('#main');
    return main && main.children.length > 0 && !main.querySelector('.empty .spin');
  }, null, { timeout: 15_000 });
}

/** Asserts the page body doesn't scroll sideways (phone layouts). */
export async function assertNoHorizontalScroll(page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
}

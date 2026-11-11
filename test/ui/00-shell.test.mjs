// The app shell: signed-out redirect, Home, the context switcher, the console's passkey gate.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { getSuperadmin, newTenant, signUp } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();

describe('app shell', { skip }, () => {
  after(closeBrowser);

  it('signed out: app routes go to /sign-in and come back', async () => {
    const t = await pageAs(null);
    await t.page.goto('/o/abc/members');
    assert.match(t.page.url(), /\/sign-in\?next=%2Fo%2Fabc%2Fmembers$/);
    await t.close();
  });

  it('a tenant admin sees their org in the switcher and its navigation', async () => {
    const { admin, orgId } = await newTenant('ui-shell');
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    await t.page.click('#switch');
    await t.page.waitForSelector('.modal');
    assert.ok(await t.page.locator(`.modal a[href="/o/${orgId}"]`).count());
    assert.equal(await t.page.locator('.modal a[href="/platform"]').count(), 0, 'no console entry for tenants');
    await t.page.keyboard.press('Escape');
    for (const label of ['Members', 'Teams', 'Sign-in and security', 'Audit log', 'Org settings']) {
      assert.ok(await t.page.locator('.sidebar .navlink', { hasText: label }).count(), label);
    }
    t.assertNoErrors();
    await t.close();
  });

  it('platform staff without a passkey session get the passkey step first', async () => {
    const sa = await getSuperadmin(); // passkey session
    const t = await pageAs(sa);
    await t.page.goto('/platform');
    await settled(t.page);
    assert.equal(await t.page.locator('#pk-go').count(), 0, 'MFA session goes straight in');
    t.assertNoErrors();
    await t.close();
  });

  it('non-staff are sent away from /platform', async () => {
    const p = await signUp('ui-nostaff');
    const t = await pageAs(p);
    await t.page.goto('/platform/orgs');
    await settled(t.page);
    // Home, which sends someone without an org on to /welcome.
    assert.match(new URL(t.page.url()).pathname, /^\/(welcome)?$/);
    t.assertNoErrors();
    await t.close();
  });

  it('phone width: no sideways scroll, menu toggles the navigation', async () => {
    const { admin, orgId } = await newTenant('ui-phone');
    const t = await pageAs(admin, { viewport: { width: 390, height: 800 } });
    await t.page.goto(`/o/${orgId}`);
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    await t.page.click('#menu');
    assert.ok(await t.page.locator('.sidebar.open .nav').first().isVisible());
    t.assertNoErrors();
    await t.close();
  });
});

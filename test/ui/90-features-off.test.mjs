// Optional modules off: a deployment that turned none of them on
// gets a console without them. The local stack runs worca-run's config (every module on), so the
// shell's <body data-features> is removed in the browser here, which is what the control Worker
// sends when FEATURES is unset; that the API answers 404 for them is checked in
// test/unit/control/features.test.ts. The same pages with the modules on are covered by 15, 60,
// 62, 65, 66 and 80.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { getSuperadmin, newTenant } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

/** A page whose shell says no module is on. */
async function withoutFeatures(person) {
  const t = await pageAs(person);
  await t.page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    const body = (await res.text()).replace(/ data-features="[^"]*"/, '');
    await route.fulfill({ response: res, body });
  });
  return t;
}

describe('a console with every optional module off', { skip }, () => {
  let sa, tenant;

  before(async () => {
    sa = await getSuperadmin();
    tenant = await newTenant('ui-features-off');
  });
  after(closeBrowser);

  it('platform nav has no Tiers and no Access requests; their pages send you to the overview', async () => {
    const t = await withoutFeatures(sa);
    await t.page.goto('/platform');
    await settled(t.page);
    const nav = await t.page.locator('#sb').innerText();
    assert.doesNotMatch(nav, /Tiers/);
    assert.doesNotMatch(nav, /Access requests/);
    assert.match(nav, /Registration/, 'registration codes stay');
    for (const path of ['/platform/tiers', '/platform/access-requests']) {
      await t.page.goto(path);
      await t.page.waitForURL(/\/platform$/);
    }
    t.assertNoErrors();
    await t.close();
  });

  it('orgs and an org show no tier; a new registration code has no plan', async () => {
    const t = await withoutFeatures(sa);
    await t.page.goto('/platform/orgs');
    await settled(t.page);
    assert.doesNotMatch(await t.page.locator('thead').innerText(), /Tier/);
    await t.page.goto(`/platform/orgs/${tenant.orgId}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-org-tier').count(), 0);
    assert.equal(await t.page.locator('#pc-tier').count(), 0);
    await t.page.goto('/platform/registration');
    await settled(t.page);
    await t.page.click('#new-code');
    await t.page.locator('.modal #nc-form').waitFor();
    assert.equal(await t.page.locator('#nc-tier').count(), 0);
    t.assertNoErrors();
    await t.close();
  });

  it('the account page has no newsletter card, and org settings show no plan', async () => {
    const t = await withoutFeatures(tenant.admin);
    await t.page.goto('/account');
    await settled(t.page);
    assert.equal(await t.page.locator('#acct-news').count(), 0);
    await t.page.goto(`/o/${tenant.orgId}/settings`);
    await settled(t.page);
    assert.doesNotMatch(await t.page.locator('.kv').first().innerText(), /Plan/);
    t.assertNoErrors();
    await t.close();
  });
});

// Provider settings, declared not coded (docs/providers.md "Settings"): the console renders the
// compute provider's own fields. Locally that is the fake provider: a deployment field (stubLabel)
// on Operations → Provider settings, an instance field (note) in the new-instance form and on the
// instance page.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { createTeam, expectStatus, getSuperadmin, newTenant } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

describe('provider settings', { skip }, () => {
  let sa, tenant;
  let savedBefore;

  before(async () => {
    sa = await getSuperadmin();
    tenant = await newTenant('ui-provider');
    await createTeam(tenant.admin, tenant.orgId, 'Builders');
    savedBefore = (await sa.get('/api/platform/provider-settings')).json().saved;
  });
  after(async () => {
    // Leave the deployment as it was for the other suites.
    await sa.put('/api/platform/provider-settings', { values: savedBefore || {} });
    await closeBrowser();
  });

  it('Operations → Provider settings: the provider\'s fields, a refused value under its field, then saved', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/ops');
    await settled(t.page);
    await t.page.click('#pc-provider-settings');
    const m = t.page.locator('.modal');
    await m.waitFor();
    assert.match(await m.locator('h2').innerText(), /Fake compute settings/);
    assert.match(await m.innerText(), /Stub label/);
    // The input's maxlength stops a longer label; the API refuses one on its own.
    const bad = await sa.put('/api/platform/provider-settings', { values: { stubLabel: 'x'.repeat(41) } });
    expectStatus(bad, 400, 'too long');
    assert.deepEqual(bad.json().problems, { stubLabel: 'at most 40 characters' });
    await m.locator('#pc-pf-stubLabel').fill('ui-label');
    await m.locator('#pc-pf-go').click();
    await m.waitFor({ state: 'detached' });
    assert.equal((await sa.get('/api/platform/provider-settings')).json().values.stubLabel, 'ui-label');
    // Reopened: the saved value is shown.
    await t.page.click('#pc-provider-settings');
    await t.page.locator('.modal').waitFor();
    assert.equal(await t.page.locator('#pc-pf-stubLabel').inputValue(), 'ui-label');
    t.assertNoErrors();
    await t.close();
  });

  it('the new-instance form has the instance fields; the instance page shows and changes them', async () => {
    const t = await pageAs(tenant.admin);
    await t.page.goto(`/o/${tenant.orgId}/instances/new`);
    await settled(t.page);
    assert.match(await t.page.locator('#c-provider legend').innerText(), /Hosting settings/);
    await t.page.fill('#c-name', 'Noted box');
    await t.page.fill('#c-pf-note', 'first note');
    await t.page.click('#c-go');
    await t.page.waitForURL(new RegExp(`/o/${tenant.orgId}/instances/[0-9a-f-]{36}$`));
    const id = t.page.url().split('/').pop();
    assert.deepEqual((await tenant.admin.get(`/api/orgs/${tenant.orgId}/instances/${id}`)).json().providerSettings, { note: 'first note' });
    await settled(t.page);
    assert.equal(await t.page.locator('#pf-line').innerText(), 'Note for the stub: first note');
    await t.page.click('#edit-provider');
    const m = t.page.locator('.modal');
    await m.waitFor();
    assert.equal(await m.locator('#pf-note').inputValue(), 'first note');
    await m.locator('#pf-note').fill('second note');
    await m.locator('#pf-go').click();
    await m.waitFor({ state: 'detached' });
    await t.page.waitForFunction(() => document.querySelector('#pf-line')?.textContent === 'Note for the stub: second note');
    t.assertNoErrors();
    await t.close();
  });

  it('keys the provider doesn\'t declare are refused', async () => {
    const { instances } = (await tenant.admin.get(`/api/orgs/${tenant.orgId}/instances`)).json();
    const res = await tenant.admin.put(`/api/orgs/${tenant.orgId}/instances/${instances[0].id}/provider-settings`, { values: { nope: 1 } });
    expectStatus(res, 400, 'unknown key');
    assert.deepEqual(res.json().problems, { nope: 'is not a setting of this provider' });
  });
});

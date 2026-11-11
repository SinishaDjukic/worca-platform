// Tiers and compute sizes (D78): the new-instance form offers the sizes the org's tier allows, the
// instance page moves an instance to another size (Worca restarts), and superadmins edit tiers on
// /platform/tiers. Instances on a size their tier no longer allows are flagged "above plan".
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { createTeam, eventually, expectStatus, getSuperadmin, newTenant } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();

describe('tiers and compute sizes', { skip }, () => {
  let sa, tenant, teamId;

  before(async () => {
    sa = await getSuperadmin();
    tenant = await newTenant('ui-sizes');
    teamId = await createTeam(tenant.admin, tenant.orgId, 'Builders');
    expectStatus(await sa.put(`/api/platform/orgs/${tenant.orgId}/tier`, { tier: 'team' }), 200, 'org on Team');
  });
  after(closeBrowser);

  it('new instance on Team: Standard and Large offered, Large picked; the page shows it', async () => {
    const t = await pageAs(tenant.admin);
    await t.page.goto(`/o/${tenant.orgId}/instances/new`);
    await settled(t.page);
    assert.match(await t.page.locator('#c-limit').innerText(), /1 of 5/);
    const labels = await t.page.locator('#c-size .check b').allInnerTexts();
    assert.deepEqual(labels, ['Standard', 'Large']);
    assert.ok(await t.page.locator('#c-size input[value=standard]').isChecked(), 'the tier default is picked');
    await t.page.check('#c-size input[value=large]');
    await t.page.fill('#c-name', 'Big box');
    await t.page.click('#c-go');
    await t.page.waitForURL(new RegExp(`/o/${tenant.orgId}/instances/[0-9a-f-]{36}$`));
    await t.page.waitForFunction(() => document.querySelector('#inst-state')?.textContent === 'Running', null, { timeout: 90_000 });
    assert.equal(await t.page.locator('#size-line').innerText(), 'Large · 4 vCPU · 8 GB · 6 agents at once');
    t.assertNoErrors();
    await t.close();
  });

  it('the size dialog moves it back to Standard; Worca restarts and it applies', async () => {
    const { instances } = (await tenant.admin.get(`/api/orgs/${tenant.orgId}/instances`)).json();
    const inst = instances.find((i) => i.name === 'Big box');
    const t = await pageAs(tenant.admin);
    await t.page.goto(`/o/${tenant.orgId}/instances/${inst.id}`);
    await settled(t.page);
    await t.page.click('#edit-size');
    const m = t.page.locator('.modal');
    await m.waitFor();
    assert.ok(await m.locator('#sz-go').isDisabled(), 'nothing to save yet');
    assert.match(await m.locator('#sz-options').innerText(), /Large current/);
    await m.locator('input[value=standard]').check();
    assert.equal(await m.locator('#sz-go').innerText(), 'Save and restart Worca');
    await m.locator('#sz-go').click();
    await eventually(async () => {
      const now = (await tenant.admin.get(`/api/orgs/${tenant.orgId}/instances/${inst.id}`)).json();
      return now.size.id === 'standard' && !now.size.pending && !now.op?.status?.match(/running/);
    }, { what: 'size applied', timeoutMs: 60_000 });
    await t.page.reload();
    await settled(t.page);
    assert.equal(await t.page.locator('#size-line').innerText(), 'Standard · 2 vCPU · 4 GB · 4 agents at once');
    assert.equal(await t.page.locator('#size-pending').count(), 0);
    t.assertNoErrors();
    await t.close();
  });

  it('a free org has one size: no choice on the form', async () => {
    const free = await newTenant('ui-sizes-free');
    await createTeam(free.admin, free.orgId, 'Solo');
    const t = await pageAs(free.admin);
    await t.page.goto(`/o/${free.orgId}/instances/new`);
    await settled(t.page);
    assert.equal(await t.page.locator('#c-size').count(), 0);
    t.assertNoErrors();
    await t.close();
  });

  it('platform: Tiers lists the tiers and sizes; a superadmin creates, edits and deletes one', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/tiers');
    await settled(t.page);
    const rows = t.page.locator('#pc-tiers tr');
    for (const name of ['Free', 'Team', 'Business']) assert.equal(await rows.filter({ hasText: name }).count() >= 1, true, name);
    assert.match(await t.page.locator('#pc-sizes').innerText(), /XL xl\s+8 vCPU · 16 GB · 8 agents and 4 scripts at once/);

    const id = `ui-${Date.now().toString(36)}`;
    await t.page.click('#pc-tier-new');
    const m = t.page.locator('.modal');
    await m.locator('#pc-t-id').fill(id);
    await m.locator('#pc-t-name').fill('Agency');
    await m.locator('#pc-t-inst').fill('20');
    await m.locator('#pc-t-s-xl').check();
    await m.locator('#pc-t-go').click();
    await t.page.locator(`tr[data-tier="${id}"]`).waitFor();
    assert.match(await t.page.locator(`tr[data-tier="${id}"]`).innerText(), /Agency[\s\S]*20[\s\S]*Standard[\s\S]*XL/);

    await t.page.click(`[data-edit="${id}"]`);
    await m.locator('#pc-t-inst').fill('25');
    await m.locator('input[name=pc-t-default][value=xl]').check();
    await m.locator('#pc-t-go').click();
    await eventually(async () => (await t.page.locator(`tr[data-tier="${id}"]`).innerText()).includes('25'), { what: 'edited tier' });
    const tier = (await sa.get('/api/platform/tiers')).json().tiers.find((x) => x.id === id);
    assert.equal(tier.default_size, 'xl');

    await t.page.click(`[data-delete="${id}"]`);
    await t.page.click('#pc-td-go');
    await eventually(async () => (await t.page.locator(`tr[data-tier="${id}"]`).count()) === 0, { what: 'tier deleted' });

    await t.page.setViewportSize({ width: 390, height: 800 });
    await t.page.reload();
    await settled(t.page);
    await assertNoHorizontalScroll(t.page);
    t.assertNoErrors();
    await t.close();
  });

  it('platform: an org moved down shows its limits; its large instance is flagged above plan', async () => {
    const { instances } = (await tenant.admin.get(`/api/orgs/${tenant.orgId}/instances`)).json();
    const inst = instances.find((i) => i.name === 'Big box');
    const set = await tenant.admin.post(`/api/orgs/${tenant.orgId}/instances/${inst.id}/size`, { size: 'large' });
    expectStatus(set, 200, 'back to large');
    expectStatus(await sa.put(`/api/platform/orgs/${tenant.orgId}/tier`, { tier: 'free' }), 200, 'org on Free');
    const t = await pageAs(sa);
    await t.page.goto(`/platform/orgs/${tenant.orgId}`);
    await settled(t.page);
    assert.match(await t.page.locator('#pc-org-tier').innerText(), /Free/);
    assert.match(await t.page.locator('#pc-org-instances').innerText(), /1\s*\/ 1/);
    assert.match(await t.page.locator('tr', { hasText: 'Big box' }).innerText(), /Large[\s\S]*above plan/);
    await t.page.goto(`/platform/instances/${inst.id}`);
    await settled(t.page);
    assert.match(await t.page.locator('#pc-size').innerText(), /Large · 4 vCPU · 8 GB/);
    t.assertNoErrors();
    await t.close();
    expectStatus(await sa.put(`/api/platform/orgs/${tenant.orgId}/tier`, { tier: 'team' }), 200, 'org on Team again');
  });
});

// Platform console, watching part (ui/assets/js/views/platform-core.mjs): overview, orgs, instances,
// operations, releases; actions per capability (support < admin < superadmin).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { createRunningInstance, eventually, expectStatus, getSuperadmin, newTenant, setStubReport, signUp } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled, assertNoHorizontalScroll } from './lib.mjs';

const skip = await skipUnlessUp();
const ROOT = new URL('../../', import.meta.url).pathname;
const TEST_TIER = 'e2e-team';

/** Runs one statement against the local database. */
function d1(command) {
  execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'worca-platform-db-dev', '--local', '-c', 'wrangler.control.jsonc', '--env', 'dev',
    '--persist-to', process.env.PERSIST_TO || '.wrangler/state',
    '--command', command,
  ], { cwd: ROOT, stdio: 'pipe' });
}

/** The local database has only the free tier; the tier test needs a second one. */
function ensureTestTier() {
  d1(`INSERT OR IGNORE INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members) VALUES ('${TEST_TIER}', 'Team (e2e)', 3, 2, 4096, 10, 25)`);
}

/** A signed-up account with a passkey session and the given platform role. */
async function staffMember(role) {
  const sa = await getSuperadmin();
  const p = await signUp(`ui-pc-${role}`, { passkey: true });
  expectStatus(await sa.post('/api/platform/roles', { userId: p.id, role }), 201, `grant ${role}`);
  return p;
}

describe('platform console: overview, orgs, instances, operations, releases', { skip }, () => {
  let sa, tenant, inst;
  const staff = [];

  before(async () => {
    sa = await getSuperadmin();
    tenant = await newTenant('ui-pc');
    inst = await createRunningInstance(tenant.admin, tenant.orgId, { name: 'Console box' });
  });
  after(async () => {
    for (const s of staff) await sa.del(`/api/platform/roles/${s.id}/${s.role}`);
    await closeBrowser();
  });

  it('overview shows the current counts, what needs a look and version adoption', async () => {
    const stats = (await sa.get('/api/platform/stats')).json();
    const { latest } = (await sa.get('/api/platform/releases')).json();
    const t = await pageAs(sa);
    await t.page.goto('/platform');
    await settled(t.page);
    assert.equal(await t.page.locator('h1').innerText(), 'Overview');
    const tile = (k) => t.page.locator('.tile', { hasText: k }).locator('.v');
    assert.ok(Number(await tile('Orgs').innerText()) >= stats.orgs.total);
    assert.ok(Number(await tile('Instances').innerText()) >= 1);
    assert.match(await t.page.locator('.tile', { hasText: 'Need a look' }).innerText(), /silent · \d+ degraded · \d+ stuck/);
    assert.equal(await tile('Waiting to join').innerText(), String(stats.waitlist));
    assert.ok(await t.page.locator('#pc-look').isVisible());
    const versions = t.page.locator('section[aria-labelledby="pc-vers"]');
    assert.match(await versions.innerText(), new RegExp(`${latest.replace(/\./g, '\\.')}\\s+latest`));
    assert.match(await t.page.locator('.pc-note').first().innerText(), /no heartbeat for 5 min/);
    // Tiles drill down.
    await t.page.click('a.tile[href="/platform/orgs"]');
    await settled(t.page);
    assert.equal(new URL(t.page.url()).pathname, '/platform/orgs');
    t.assertNoErrors();
    await t.close();
  });

  it('orgs: search, open one, change its tier', async () => {
    ensureTestTier();
    const t = await pageAs(sa);
    await t.page.goto('/platform/orgs');
    await settled(t.page);
    await t.page.fill('#pc-q', tenant.admin.email);
    const rows = t.page.locator('#pc-orgs tr');
    await eventually(async () => (await rows.count()) === 1, { what: 'one matching org' });
    assert.match(await rows.first().innerText(), new RegExp(tenant.orgId));
    await t.page.fill('#pc-q', 'no-such-org-xyz');
    assert.match(await rows.first().innerText(), /No org matches/);
    await t.page.fill('#pc-q', tenant.orgId);
    await rows.first().locator('a.pc-name').click();
    await settled(t.page);
    assert.equal(new URL(t.page.url()).pathname, `/platform/orgs/${tenant.orgId}`);
    assert.match(await t.page.locator('section[aria-labelledby="pc-admins"]').innerText(), new RegExp(tenant.admin.email.replace(/[.+]/g, '\\$&')));
    const instRow = t.page.locator('section[aria-labelledby="pc-oinst"] tbody tr', { hasText: 'Console box' });
    assert.match(await instRow.innerText(), /Running/);

    await t.page.click('#pc-tier');
    await t.page.waitForSelector('.modal');
    assert.ok(await t.page.locator('.modal input[value="free"]').isChecked());
    await t.page.locator(`.modal input[value="${TEST_TIER}"]`).check();
    await t.page.click('#pc-tier-go');
    await t.page.waitForSelector('#toasts .toast');
    assert.match(await t.page.locator('#toasts .toast').last().innerText(), /is on Team \(e2e\)/);
    await eventually(async () => (await t.page.locator('.mini').first().innerText()).includes('Team (e2e)'), { what: 'tier shown', timeoutMs: 10_000 });
    const org = (await sa.get(`/api/platform/orgs/${tenant.orgId}`)).json();
    assert.equal(org.tier, TEST_TIER);
    expectStatus(await sa.put(`/api/platform/orgs/${tenant.orgId}/tier`, { tier: 'free' }), 200, 'tier back to free');
    t.assertNoErrors();
    await t.close();
  });

  it('instances: filters, then the detail with operation, providers and gate', async () => {
    // The create op reads the compute facts right after the first heartbeat.
    const detail = await eventually(async () => {
      const d = (await sa.get(`/api/platform/instances/${inst.id}`)).json();
      return d.compute ? d : null;
    }, { what: 'compute facts' });
    const t = await pageAs(sa);
    await t.page.goto(`/platform/instances?org=${tenant.orgId}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-org').inputValue(), tenant.orgId);
    const rows = t.page.locator('tbody tr');
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /Console box/);
    await t.page.click('.pc-tabs a:has-text("Stopped")');
    await settled(t.page);
    assert.match(new URL(t.page.url()).search, /f=stopped/);
    assert.match(await rows.first().innerText(), /No instance matches/);
    await t.page.click('.pc-tabs a:has-text("Running")');
    await settled(t.page);
    assert.match(await rows.first().innerText(), /Console box/);
    // The org filter clears through the select.
    await t.page.selectOption('#pc-org', '');
    await settled(t.page);
    assert.equal(new URL(t.page.url()).search, '?f=running');

    await t.page.goto(`/platform/instances/${inst.id}`);
    await settled(t.page);
    assert.equal(await t.page.locator('h1').innerText(), 'Console box');
    const text = await t.page.locator('#main').innerText();
    assert.match(text, /You see status and counts only/);
    assert.match(text, /Create operation/);
    assert.match(text, /Gate status\s+running/);
    assert.match(text, /Providers/);
    // Compute facts from the (fake) provider: the EU, per-service ceilings, no note.
    assert.match(text, /Region\s+EU West \(Amsterdam\) · europe-west4-drams3a/);
    assert.match(text, /Worca\s+2 vCPU · 4 GB · 50 GB volume/);
    assert.match(text, /Broker\s+2 vCPU · 4 GB · 50 GB volume/);
    assert.match(text, /Tunnel\s+2 vCPU · 4 GB(?! ·)/);
    assert.match(text, /Limits are ceilings, as the provider reports them\. Checked /);
    assert.equal(await t.page.locator('#pc-region-note').count(), 0);
    // An instance created before the EU placement fix: the provider reports US West.
    d1(`UPDATE instances SET compute_facts = json_set(compute_facts, '$.region', 'sfo'), compute_facts_at = ${Date.now()} WHERE id = '${inst.id}'`);
    await t.page.reload();
    await settled(t.page);
    assert.match(await t.page.locator('#pc-region').innerText(), /US West \(California\) · sfo\s+Created before EU placement; recreate the instance to move it to the EU/);
    assert.ok(text.includes(detail.edgeRef.tunnelId), 'tunnel id shown');
    assert.ok(text.includes(detail.computeRef.projectId), 'compute project id shown');
    assert.match(text, /Fake compute project/);
    assert.ok(await t.page.locator(`[data-copy="${detail.edgeRef.tunnelId}"]`).count(), 'copy button for the tunnel');
    assert.ok(await t.page.locator('#pc-stop').isVisible(), 'superadmin may stop');
    // The address is shown and linked (the gate still refuses every platform role, D15).
    assert.equal(await t.page.locator(`#main .pc-insturl a[href*="${inst.host}"]`).count(), 1);
    t.assertNoErrors();
    await t.close();
  });

  it('stop for abuse, then lift the stop', async () => {
    const t = await pageAs(sa);
    await t.page.goto(`/platform/instances/${inst.id}`);
    await settled(t.page);
    await t.page.click('#pc-stop');
    await t.page.waitForSelector('.modal');
    assert.ok(await t.page.locator('#pc-stop-go').isDisabled(), 'a reason is required');
    await t.page.fill('#pc-why', 'UI test: outbound traffic to a mining pool');
    await t.page.click('#pc-stop-go');
    await t.page.waitForSelector('#pc-lift');
    assert.match(await t.page.locator('#main').innerText(), /Stop reason\.\s+UI test: outbound traffic to a mining pool/);
    assert.match(await t.page.locator('section[aria-labelledby="pc-det"] .kv').innerText(), /Stopped\s+Stopped for abuse/);
    assert.equal((await sa.get(`/api/platform/instances/${inst.id}`)).json().status, 'stopped');

    await t.page.click('#pc-lift');
    await t.page.waitForSelector('.modal');
    await t.page.click('#pc-lift-go');
    await t.page.waitForSelector('#toasts .toast');
    await eventually(async () => (await sa.get(`/api/platform/instances/${inst.id}`)).json().status === 'running', { timeoutMs: 90_000, what: 'lift to finish' });
    // The view polls every 5 s while the lift runs.
    await t.page.waitForSelector('#pc-stop', { timeout: 30_000 });
    assert.doesNotMatch(await t.page.locator('#main').innerText(), /Stop reason/);
    t.assertNoErrors();
    await t.close();
  });

  it('renew credentials (D74): the instance restarts, reports in with its new credential, and the page says when', async () => {
    const t = await pageAs(sa);
    await t.page.goto(`/platform/instances/${inst.id}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-rotated').innerText(), 'never');
    await t.page.click('#pc-rotate');
    await t.page.waitForSelector('.modal');
    assert.match(await t.page.locator('.modal').innerText(), /restarts for about a minute/);
    await t.page.click('#pc-rotate-go');
    await t.page.waitForSelector('#toasts .toast');
    await eventually(async () => {
      const { op, status } = (await sa.get(`/api/platform/instances/${inst.id}`)).json();
      return op?.kind === 'rotate' && op.status === 'done' && status === 'running';
    }, { timeoutMs: 120_000, what: 'the rotation to finish' });
    await t.page.reload();
    await settled(t.page);
    assert.notEqual(await t.page.locator('#pc-rotated').innerText(), 'never');
    assert.match(await t.page.locator('#pc-op').innerText(), /Renew credentials operation/);
    t.assertNoErrors();
    await t.close();
  });

  it('operations: the three tabs render', async () => {
    const t = await pageAs(sa);
    await t.page.goto('/platform/ops');
    await settled(t.page);
    assert.equal(await t.page.locator('.pc-tabs a.on').innerText(), 'Stuck');
    assert.match(await t.page.locator('thead').innerText(), /Phase and step/);
    for (const [tab, re] of [['Failed', /Took/], ['Running', /In phase for/]]) {
      await t.page.click(`.pc-tabs a:has-text("${tab}")`);
      await settled(t.page);
      assert.equal(await t.page.locator('.pc-tabs a.on').innerText(), tab);
      assert.match(await t.page.locator('thead').innerText(), re);
    }
    // The lift of the previous test is the instance's latest operation; its row links to the detail.
    await t.page.goto('/platform/ops?state=failed');
    await settled(t.page);
    const links = t.page.locator('tbody a.pc-name');
    if (await links.count()) {
      await links.first().click();
      await settled(t.page);
      assert.match(new URL(t.page.url()).pathname, /^\/platform\/instances\//);
    }
    t.assertNoErrors();
    await t.close();
  });

  it('releases: a superadmin publishes a version and it becomes the latest', async () => {
    const before = (await sa.get('/api/platform/releases')).json();
    const version = `1.9.${1000 + Math.floor(Math.random() * 8000)}`;
    const t = await pageAs(sa);
    try {
      await t.page.goto('/platform/releases');
      await settled(t.page);
      await t.page.click('#pc-publish');
      await t.page.waitForSelector('.modal');
      assert.match(await t.page.locator('.modal').innerText(), /Nobody is upgraded automatically/);
      await t.page.fill('#pc-ver', 'abc');
      assert.ok(await t.page.locator('#pc-ver-go').isDisabled());
      await t.page.fill('#pc-ver', version);
      await t.page.click('#pc-ver-go');
      await t.page.waitForSelector(`tr[data-version="${version}"]`);
      assert.match(await t.page.locator(`tr[data-version="${version}"]`).innerText(), /latest[\s\S]*you/);
      assert.equal((await sa.get('/api/platform/releases')).json().latest, version);
      t.assertNoErrors();
    } finally {
      // Put the shared stack's latest back (other suites create and upgrade instances).
      expectStatus(await sa.put('/api/platform/worca-version', { version: before.latest }), 200, 'restore latest');
      await t.close();
    }
  });

  // D77: a superadmin withdraws a release; the org admin of an instance on it sees why.
  it('releases: withdraw a release, the tenant sees it on the instance, then restore it', async () => {
    const before = (await sa.get('/api/platform/releases')).json();
    // Always the newest, also above versions earlier runs left on the shared stack.
    const version = `1.9.${Math.floor(Date.now() / 1000)}`;
    const reason = 'Leaks the broker secret into the run log.';
    expectStatus(await sa.put('/api/platform/worca-version', { version }), 200, 'publish');
    await setStubReport(inst.id, { version });
    const path = `/api/orgs/${tenant.orgId}/instances/${inst.id}`;
    await eventually(async () => (await tenant.admin.get(path)).json().version === version, { what: 'the instance reports the new version' });
    const t = await pageAs(sa);
    const ta = await pageAs(tenant.admin);
    try {
      await t.page.goto('/platform/releases');
      await settled(t.page);
      await t.page.click(`[data-withdraw="${version}"]`);
      await t.page.waitForSelector('.modal');
      assert.match(await t.page.locator('.modal').innerText(), /1 instance runs it/);
      assert.ok(await t.page.locator('#pc-wd-go').isDisabled(), 'a reason is required');
      await t.page.fill('#pc-wd-why', reason);
      await t.page.click('#pc-wd-go');
      await t.page.waitForSelector(`tr[data-version="${version}"] [data-restore]`);
      assert.match(await t.page.locator(`tr[data-version="${version}"]`).innerText(), new RegExp(`withdrawn[\\s\\S]*${reason.replace(/\./g, '\\.')}`));
      // The newest release left is the latest (older runs leave their versions on the shared stack).
      assert.notEqual((await sa.get('/api/platform/releases')).json().latest, version, 'no longer the latest');

      await ta.page.goto(`/o/${tenant.orgId}/instances/${inst.id}`);
      await settled(ta.page);
      const banner = ta.page.locator('#inst-withdrawn');
      assert.match(await banner.innerText(), new RegExp(`Worca ${version.replace(/\./g, '\\.')} was withdrawn[\\s\\S]*${reason.replace(/\./g, '\\.')}`));
      assert.equal(await ta.page.locator('#inst-upgrade').count(), 0, 'no second banner');
      await ta.page.click('#withdrawn-move');
      await ta.page.waitForSelector('.modal');
      assert.equal(await ta.page.locator(`.modal [value="${version}"]`).count(), 0, 'the withdrawn version is not offered');
      ta.assertNoErrors();

      await t.page.click(`[data-restore="${version}"]`);
      await t.page.waitForSelector('.modal');
      await t.page.click('#pc-rs-go');
      await t.page.waitForSelector(`tr[data-version="${version}"] [data-withdraw]`);
      assert.equal((await sa.get('/api/platform/releases')).json().latest, version, 'the newest again');
      t.assertNoErrors();
    } finally {
      await setStubReport(inst.id, { version: null });
      expectStatus(await sa.put('/api/platform/worca-version', { version: before.latest }), 200, 'restore latest');
      await t.close();
      await ta.close();
    }
  });

  // D80: a superadmin turns release candidates on for an org; its admin then sees them in the picker.
  it('release candidates: on for the org, listed as such, offered to its admin with the pinning note', async () => {
    const rc = `99.0.0-rc.${Math.floor(Date.now() / 1000)}`;
    d1(`INSERT INTO worca_releases (version, published_at, published_by, source) VALUES ('${rc}', ${Date.now()}, NULL, 'npm')`);
    const t = await pageAs(sa);
    const ta = await pageAs(tenant.admin);
    try {
      await t.page.goto(`/platform/orgs/${tenant.orgId}`);
      await settled(t.page);
      assert.match(await t.page.locator('#pc-org-rc').innerText(), /Off/);
      await t.page.click('#pc-rc-toggle');
      await eventually(async () => /On/.test(await t.page.locator('#pc-org-rc').innerText()), { what: 'release candidates on', timeoutMs: 10_000 });
      assert.equal((await sa.get(`/api/platform/orgs/${tenant.orgId}`)).json().releaseCandidates, true);

      await t.page.goto('/platform/releases');
      await settled(t.page);
      assert.match(await t.page.locator(`tr[data-version="${rc}"]`).innerText(), /release candidate/);
      assert.equal(await t.page.locator(`tr[data-version="${rc}"] .pc-latest`).count(), 0, 'never the latest');

      await ta.page.goto(`/o/${tenant.orgId}/instances/${inst.id}`);
      await settled(ta.page);
      await ta.page.waitForSelector('#change-version', { timeout: 40_000 });
      await ta.page.click('#change-version');
      await ta.page.waitForSelector('#up-version');
      assert.ok(await ta.page.locator('#up-rc').isHidden(), 'no note for the preselected latest');
      assert.match(await ta.page.locator(`#up-version option[value="${rc}"]`).innerText(), /release candidate/);
      await ta.page.selectOption('#up-version', rc);
      assert.ok(await ta.page.locator('#up-rc').isVisible(), 'a candidate shows the pinning note');
      assert.equal((await ta.page.locator('#up-go').innerText()).trim(), `Change to ${rc}`);
      await ta.page.click('.modal [data-close]');
      ta.assertNoErrors();

      await t.page.goto(`/platform/orgs/${tenant.orgId}`);
      await settled(t.page);
      await t.page.click('#pc-rc-toggle');
      await eventually(async () => /Off/.test(await t.page.locator('#pc-org-rc').innerText()), { what: 'release candidates off', timeoutMs: 10_000 });
      t.assertNoErrors();
    } finally {
      await sa.put(`/api/platform/orgs/${tenant.orgId}/release-candidates`, { enabled: false });
      d1(`DELETE FROM worca_releases WHERE version = '${rc}'`);
      await t.close();
      await ta.close();
    }
  });

  it('releases: a superadmin changes the release settings', async () => {
    const t = await pageAs(sa);
    try {
      await t.page.goto('/platform/releases');
      await settled(t.page);
      assert.match(await t.page.locator('#pc-rel-settings').innerText(), /Automatic enrollment\s*On[\s\S]*take a release as soon as it is enrolled/);
      await t.page.click('#pc-rel-edit');
      await t.page.waitForSelector('.modal');
      await t.page.uncheck('#pc-rel-auto');
      await t.page.fill('#pc-rel-soak', '1000');
      assert.ok(await t.page.locator('#pc-rel-go').isDisabled());
      await t.page.fill('#pc-rel-soak', '12');
      await t.page.click('#pc-rel-go');
      await t.page.waitForFunction(() => /Off[\s\S]*wait 12 hours/.test(document.querySelector('#pc-rel-settings')?.innerText || ''));
      assert.deepEqual((await sa.get('/api/platform/releases')).json().settings, { autoEnroll: false, soakHours: 12 });
      t.assertNoErrors();
    } finally {
      expectStatus(await sa.put('/api/platform/release-settings', { autoEnroll: true, soakHours: 0 }), 200, 'reset settings');
      await t.close();
    }
  });

  it('support sees everything read-only; admin may change tiers and stop, not publish', async () => {
    const support = await staffMember('support');
    staff.push({ id: support.id, role: 'support' });
    const t = await pageAs(support);
    await t.page.goto(`/platform/orgs/${tenant.orgId}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-tier').count(), 0);
    await t.page.goto(`/platform/instances/${inst.id}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-stop, #pc-lift, #pc-rotate').count(), 0);
    assert.match(await t.page.locator('#main').innerText(), /Provider references/);
    await t.page.goto('/platform/releases');
    await settled(t.page);
    assert.equal(await t.page.locator('#pc-publish').count(), 0);
    assert.ok(await t.page.locator('tbody tr').count());
    await t.page.goto('/platform/ops?state=failed');
    await settled(t.page);
    assert.equal(await t.page.locator('[data-restart], #pc-rotate-all').count(), 0);
    await t.page.goto('/platform');
    await settled(t.page);
    assert.equal(await t.page.locator('a[href="/platform/registration"]').count(), 0, 'no waitlist link without waitlist.manage');
    t.assertNoErrors();
    await t.close();

    const admin = await staffMember('admin');
    staff.push({ id: admin.id, role: 'admin' });
    const a = await pageAs(admin);
    await a.page.goto(`/platform/orgs/${tenant.orgId}`);
    await settled(a.page);
    assert.ok(await a.page.locator('#pc-tier').isVisible());
    await a.page.goto(`/platform/instances/${inst.id}`);
    await settled(a.page);
    assert.equal(await a.page.locator('#pc-stop, #pc-lift').count(), 1, 'admin may stop or lift');
    assert.equal(await a.page.locator('#pc-rotate').count(), 1, 'admin may renew credentials');
    await a.page.goto('/platform/releases');
    await settled(a.page);
    assert.equal(await a.page.locator('#pc-publish').count(), 0);
    a.assertNoErrors();
    await a.close();
  });

  it('phone width: overview, instances and the instance detail fit', async () => {
    const t = await pageAs(sa, { viewport: { width: 390, height: 800 } });
    for (const path of ['/platform', '/platform/instances', `/platform/instances/${inst.id}`, '/platform/ops', '/platform/orgs']) {
      await t.page.goto(path);
      await settled(t.page);
      await assertNoHorizontalScroll(t.page);
    }
    t.assertNoErrors();
    await t.close();
  });
});

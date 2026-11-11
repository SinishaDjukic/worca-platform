// Org administration views (ui/assets/js/views/org-admin.mjs): sign-in and security (policy with
// the D31 lock-out flow, domains, SSO), the audit log, org settings (rename, key rotation, delete).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { startFakeIdp } from '../e2e/lib/fake-idp.mjs';
import { createTeam, eventually, expectStatus, inviteAndJoin, newTenant } from '../e2e/lib/flows.mjs';
import { assertNoHorizontalScroll, closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

/** Writes to the local D1 (domain verification needs real DNS). */
function d1(sql) {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'worca-platform-db-dev', '--local', '-c', 'wrangler.control.jsonc', '--env', 'dev', '--persist-to', process.env.PERSIST_TO || '.wrangler/state', '--command', sql], {
    cwd: new URL('../..', import.meta.url),
    stdio: 'pipe',
  });
}
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

describe('org admin views', { skip }, () => {
  let admin, orgId, orgName;
  before(async () => {
    ({ admin, orgId, orgName } = await newTenant('ui-oa'));
  });
  after(closeBrowser);

  it('security: a policy change that locks nobody out applies at once; instance overrides are listed', async () => {
    const teamId = await createTeam(admin, orgId, 'Strict team');
    const inst = expectStatus(await admin.post(`/api/orgs/${orgId}/instances`, { name: 'Strict one', teamId, policy: { requiredMethods: ['passkey'] } }), 201, 'create instance').json();
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/security`);
    await settled(t.page);
    const override = t.page.locator(`a.row[href="/o/${orgId}/instances/${inst.id}"]`);
    assert.match(await override.innerText(), /Strict one[\s\S]*Requires Passkey/);
    await t.page.locator('label[for="m-google"]').click();
    assert.equal(await t.page.locator('#m-google').isChecked(), false);
    await t.page.click('#save-policy');
    // A plain save reports on its button, as in worca.
    await t.page.locator('#save-policy.is-done', { hasText: 'Saved' }).waitFor();
    const pol = (await admin.get(`/api/orgs/${orgId}/policy`)).json();
    assert.deepEqual(pol.allowedMethods, ['email-otp', 'passkey', 'microsoft', 'sso']);
    await settled(t.page);
    assert.equal(await t.page.locator('#m-google').isChecked(), false, 'saved state shown');
    // Nothing selected: refused in the page.
    for (const m of ['email-otp', 'passkey', 'microsoft', 'sso']) await t.page.locator(`label[for="m-${m}"]`).click();
    await t.page.click('#save-policy');
    // One rule for the switches: the problem shows under them, as in worca.
    assert.match(await t.page.locator('.field', { has: t.page.locator('#m-email-otp') }).locator('.field-error').innerText(), /at least one/);
    assert.equal(await t.page.locator('#m-email-otp').getAttribute('aria-invalid'), 'true');
    t.assertNoErrors();
    await t.close();
  });

  it('security: outbound network (D73): modes, field errors under the lists, always-allowed hosts, the not-enforced note, a save that restarts nothing', async () => {
    const tenant = await newTenant('ui-oa-eg');
    const t = await pageAs(tenant.admin);
    await t.page.goto(`/o/${tenant.orgId}/security`);
    await settled(t.page);
    const card = t.page.locator('#egress-card');
    assert.match(await card.locator('#eg-note').innerText(), /Saved and sent to your instances\. Worca applies it from version 1\.11\.0; instances on older versions ignore it\. It covers tools that go through Worca's proxy, which most do; a program that bypasses the proxy on purpose can still connect\./);
    assert.match(await card.innerText(), /Always allowed[\s\S]*app\.localhost[\s\S]*worca-platform-broker\.railway\.internal/i);
    assert.match(await card.locator('#eg-count').innerText(), /0 instances follow this policy/);
    assert.equal(await card.locator('input[name="eg-mode"][value="open"]').isChecked(), true);
    assert.ok(await t.page.locator('#eg-save').isDisabled(), 'nothing changed yet');
    assert.equal(await t.page.locator('#eg-allow').isVisible(), false);
    assert.equal(await t.page.locator('#eg-deny').isVisible(), false);

    // Block mode: the blocklist shows; a bad entry and a platform host are refused under it.
    await card.locator('input[name="eg-mode"][value="block"]').check();
    assert.equal(await t.page.locator('#eg-deny').isVisible(), true);
    await t.page.fill('#eg-deny', 'pastebin.com\nhttps://bad.example');
    await t.page.click('#eg-save');
    await t.page.locator('#eg-deny-f .field-error').waitFor();
    assert.match(await t.page.locator('#eg-deny-f .field-error').innerText(), /"https:\/\/bad\.example": Leave out https:\/\//);
    assert.equal(await t.page.locator('#eg-deny').getAttribute('aria-invalid'), 'true');
    await t.page.fill('#eg-deny', 'pastebin.com\napp.localhost');
    await t.page.click('#eg-save');
    await t.page.locator('#eg-deny-f .field-error', { hasText: 'needs to work' }).waitFor();

    await t.page.fill('#eg-deny', 'pastebin.com\n*.ngrok.io');
    await t.page.click('#eg-save');
    await t.page.locator('#eg-save.is-done', { hasText: 'Saved' }).waitFor();
    const saved = expectStatus(await tenant.admin.get(`/api/orgs/${tenant.orgId}/egress`), 200).json();
    assert.deepEqual(saved.policy, { mode: 'block', allow: [], deny: ['pastebin.com', '*.ngrok.io'] });
    assert.equal(saved.version, 1);

    // Allow mode: the allowlist shows, the blocklist carves exceptions out of it.
    await card.locator('input[name="eg-mode"][value="allow"]').check();
    assert.equal(await t.page.locator('#eg-allow').isVisible(), true);
    assert.match(await t.page.locator('#eg-deny-hint').innerText(), /blocking always wins/);
    await t.page.fill('#eg-allow', 'github.com, *.githubusercontent.com');
    await t.page.fill('#eg-deny', '');
    await t.page.click('#eg-save');
    await t.page.locator('#eg-save.is-done', { hasText: 'Saved' }).waitFor();
    assert.deepEqual(expectStatus(await tenant.admin.get(`/api/orgs/${tenant.orgId}/egress`), 200).json().policy, { mode: 'allow', allow: ['github.com', '*.githubusercontent.com'], deny: [] });

    // Changed meanwhile (another admin): refused in the section, which shows the current policy.
    await tenant.admin.put(`/api/orgs/${tenant.orgId}/egress`, { policy: { mode: 'open' }, version: 2 });
    await card.locator('input[name="eg-mode"][value="block"]').check();
    await t.page.fill('#eg-deny', 'x.example');
    await t.page.click('#eg-save');
    await t.page.locator('#eg-err', { hasText: 'changed this policy meanwhile' }).waitFor();
    assert.equal(await card.locator('input[name="eg-mode"][value="open"]').isChecked(), true);
    t.assertNoErrors();
    await t.close();
  });

  it('security: a policy that locks a member out names them, asks for the org name, then for email confirmation', async () => {
    const member = await inviteAndJoin(admin, orgId, 'ui-oa-member');
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/security`);
    await settled(t.page);
    for (const m of ['email-otp', 'microsoft', 'sso']) if (await t.page.locator(`#m-${m}`).isChecked()) await t.page.locator(`label[for="m-${m}"]`).click();
    await t.page.click('#save-policy');
    const modal = t.page.locator('.modal');
    await modal.locator('#pa-name').waitFor();
    assert.match(await modal.innerText(), new RegExp(member.email.replace(/[.+]/g, '\\$&')));
    assert.ok(await modal.locator('#pa-go').isDisabled(), 'needs the typed name');
    await modal.locator('#pa-name').fill(orgName);
    await modal.locator('#pa-go').click();
    await t.page.locator('.modal h2', { hasText: 'Check your email' }).waitFor();
    const pol = (await admin.get(`/api/orgs/${orgId}/policy`)).json();
    assert.ok(pol.allowedMethods.includes('email-otp'), 'nothing changes before the emailed confirmation');
    t.assertNoErrors();
    await t.close();
  });

  it('security: adding a domain shows the TXT record; checking it explains the record is not there yet', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/security`);
    await settled(t.page);
    await t.page.click('#add-domain');
    await t.page.fill('#dom-name', 'not a domain');
    await t.page.click('#dom-go');
    assert.match(await t.page.locator('.field', { has: t.page.locator('#dom-name') }).locator('.field-error').innerText(), /doesn't look like a domain/);
    assert.equal(await t.page.locator('#dom-name').getAttribute('aria-invalid'), 'true');
    const domain = `ui-oa-${Date.now()}.example.com`;
    await t.page.fill('#dom-name', domain);
    await t.page.click('#dom-go');
    const txt = t.page.locator('.modal', { hasText: 'Add this TXT record' });
    await txt.waitFor();
    assert.ok(await txt.locator(`[data-copy="_worca-verification.${domain}"]`).count(), 'record name with a copy button');
    assert.ok(await txt.locator('[data-copy^="worca-verification="]').count(), 'record value with a copy button');
    await txt.locator('#txt-go').click();
    await txt.locator('#txt-err.banner.red', { hasText: "didn't find the TXT record" }).waitFor();
    await txt.locator('[data-close]').click();
    await settled(t.page);
    const row = t.page.locator('.row.oa-pending', { hasText: domain });
    await row.waitFor();
    await row.locator('[data-verify]').click();
    await t.page.locator('.modal h2', { hasText: 'Record not found yet' }).waitFor();
    await t.page.keyboard.press('Escape');
    // Removing it.
    await row.locator('[data-rm-domain]').click();
    await t.page.locator('#cf-go').click();
    await t.page.locator('#toasts .toast', { hasText: 'Domain removed' }).waitFor();
    t.assertNoErrors();
    await t.close();
  });

  it('security: SSO is connected through the form (fake OIDC IdP), listed with its URLs, and removed through the protected flow', async () => {
    const idp = await startFakeIdp();
    try {
      // A verified domain (verification needs real DNS: marked in the local D1).
      const domain = `sso-${Date.now()}.e2e.test`;
      const d = expectStatus(await admin.post(`/api/orgs/${orgId}/domains`, { domain }), 201, 'add domain').json();
      d1(`UPDATE org_domains SET verified_at = ${Date.now()} WHERE id = ${sqlStr(d.id)}`);
      const providerId = `sso-ui${Date.now().toString(36)}`;
      const t = await pageAs(admin);
      await t.page.goto(`/o/${orgId}/security`);
      await settled(t.page);
      await t.page.click('#add-sso');
      await t.page.selectOption('#sso-dom', d.id);

      // Validation in the page, before any request.
      await t.page.click('#sso-go');
      assert.match(await t.page.locator('.field', { has: t.page.locator('#sso-issuer') }).locator('.field-error').innerText(), /issuer URL/);
      await t.page.fill('#sso-issuer', idp.issuer);
      await t.page.click('#sso-go');
      assert.match(await t.page.locator('.field', { has: t.page.locator('#sso-cid') }).locator('.field-error').innerText(), /client id and the client secret/);
      await t.page.fill('#sso-cid', idp.clientId);
      await t.page.fill('#sso-secret', idp.clientSecret);
      await t.page.fill('#sso-pid', 'Bad Id');
      await t.page.click('#sso-go');
      assert.match(await t.page.locator('.field', { has: t.page.locator('#sso-pid') }).locator('.field-error').innerText(), /connection id starts with sso-/);
      await t.page.check('#sso-manual');
      await t.page.fill('#sso-pid', providerId);
      await t.page.click('#sso-go');
      assert.match(await t.page.locator('.field', { has: t.page.locator('#sso-auth') }).locator('.field-error').innerText(), /authorization, token and JWKS/);
      await t.page.uncheck('#sso-manual');
      // SAML panels switch.
      await t.page.click('.modal [data-type="saml"]');
      assert.ok(await t.page.locator('#sso-meta').isVisible());
      await t.page.click('.modal [data-saml="manual"]');
      assert.ok(await t.page.locator('#sso-entry').isVisible());
      await t.page.click('#sso-go');
      assert.match(await t.page.locator('.field', { has: t.page.locator('#sso-entity') }).locator('.field-error').innerText(), /entity id/);
      await t.page.click('.modal [data-type="oidc"]');

      // A server refusal shows the plain message and the server's detail: discovery at a dead address.
      await t.page.fill('#sso-disc', 'http://127.0.0.1:9/.well-known/openid-configuration');
      await t.page.click('#sso-go');
      await t.page.locator('#sso-err.banner.red', { hasText: /discovery|address|allowed/i }).waitFor();
      await t.page.fill('#sso-disc', '');

      // Real registration through discovery.
      await t.page.click('#sso-go');
      const done = t.page.locator('.modal', { hasText: 'SSO connected' });
      await done.waitFor({ timeout: 20_000 });
      assert.ok(await done.locator(`[data-copy$="/api/auth/sso/callback/${providerId}"]`).count(), 'redirect URL to enter at the IdP');
      await done.locator('[data-close]').click();
      await settled(t.page);

      const block = t.page.locator(`.oa-sso[data-sso="${providerId}"]`);
      await block.waitFor();
      const text = await block.innerText();
      assert.match(text, /Active/);
      assert.match(text, /OpenID Connect/);
      assert.match(text, new RegExp(`@${domain.replace(/\./g, '\\.')}`));
      assert.ok(await block.locator(`[data-copy$="/api/auth/sso/callback/${providerId}"]`).count(), 'redirect URL with a copy button');
      assert.match(await t.page.locator('label[for="m-sso"]').innerText(), new RegExp(domain.replace(/\./g, '\\.')));

      // The same id again: provider_id_taken.
      await t.page.click('#add-sso');
      await t.page.selectOption('#sso-dom', d.id);
      await t.page.fill('#sso-issuer', idp.issuer);
      await t.page.fill('#sso-cid', idp.clientId);
      await t.page.fill('#sso-secret', idp.clientSecret);
      await t.page.fill('#sso-pid', providerId);
      await t.page.click('#sso-go');
      await t.page.locator('.field', { has: t.page.locator('#sso-pid') }).locator('.field-error').filter({ hasText: 'already in use' }).waitFor();
      await t.page.keyboard.press('Escape');

      // Remove: nobody depends on it, so it goes after the plain confirmation.
      await block.locator('[data-rm-sso]').click();
      await t.page.locator('#cf-go').click();
      await t.page.locator('#toasts .toast', { hasText: 'SSO connection removed' }).waitFor();
      await settled(t.page);
      assert.equal(await t.page.locator(`.oa-sso[data-sso="${providerId}"]`).count(), 0);
      t.assertNoErrors();
      await t.close();
    } finally {
      await idp.close();
    }
  });

  it('audit: shows what happened, filters by category, exports CSV', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/audit`);
    await settled(t.page);
    await t.page.locator('table.oa-audit').waitFor();
    const all = await t.page.locator('table.oa-audit tbody').innerText();
    assert.match(all, /Created the org/);
    assert.match(all, /Added the domain/);
    assert.match(all, /Changed the login policy/);
    await t.page.click('[data-cat="security"]');
    await eventually(async () => !/Created the org/.test(await t.page.locator('#audit-body').innerText()), { what: 'security filter' });
    const sec = await t.page.locator('#audit-body').innerText();
    assert.match(sec, /Added the domain/);
    assert.match(new URL(t.page.url()).search, /category=security/);
    const [dl] = await Promise.all([t.page.waitForEvent('download'), t.page.click('#csv')]);
    assert.match(dl.suggestedFilename(), /^audit-.*\.csv$/);
    const csv = readFileSync(await dl.path(), 'utf8');
    assert.match(csv, /^﻿time,who,who_id,category,action,description/);
    assert.match(csv, /domain\.added/);
    assert.doesNotMatch(csv, /org\.created/);
    // Person filter: someone who did nothing.
    await t.page.click('[data-cat=""]');
    const other = await t.page.locator('#f-person option').nth(2).getAttribute('value');
    await t.page.selectOption('#f-person', other);
    await t.page.locator('#audit-body .empty', { hasText: 'Nothing matches' }).waitFor();
    t.assertNoErrors();
    await t.close();
  });

  it('settings: rename updates the switcher; key rotation shows its progress', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/settings`);
    await settled(t.page);
    assert.match(await t.page.locator('.kv').first().innerText(), /Plan[\s\S]*instance/);
    assert.ok(await t.page.locator('#name-save').isDisabled());
    orgName = `Renamed ${Date.now()}`;
    await t.page.fill('#o-name', orgName);
    await t.page.click('#name-save');
    await t.page.locator('#name-save.is-done', { hasText: 'Saved' }).waitFor();
    await t.page.locator('#switch', { hasText: orgName }).waitFor();

    await t.page.click('#rotate');
    await t.page.locator('#cf-go').click();
    await t.page.locator('#toasts .toast', { hasText: 'Rotating to key version 2' }).waitFor();
    // The local stack runs KeyRotationWorkflow: re-encryption, then a 3-minute check (VERIFY_GRACE_MS).
    await t.page.locator('#key-card [data-running]').waitFor();
    await t.page.locator('#key-card', { hasText: /Re-encrypt[\s\S]*\d+ of \d+/ }).waitFor();
    assert.ok(await t.page.locator('#rotate').isDisabled(), 'no second rotation while one runs');
    await t.page.locator('#key-card', { hasText: 'checking that nothing was missed' }).waitFor({ timeout: 30_000 });
    assert.match(await t.page.locator('#key-card').innerText(), /Key version 2[\s\S]*Last rotated/);
    const bar = await t.page.locator('#key-card .meter i').evaluate((i) => i.style.width);
    assert.equal(bar, '100%');
    // While it runs the API refuses another rotation too.
    expectStatus(await admin.post(`/api/orgs/${orgId}/keys/rotate`, {}), 409, 'rotation in progress');
    t.assertNoErrors();
    await t.close();
  });

  it('settings: deleting the org asks for the name and ends with "check your email"', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/settings`);
    await settled(t.page);
    await t.page.click('#del-org');
    await t.page.fill('#pa-name', 'wrong');
    assert.ok(await t.page.locator('#pa-go').isDisabled());
    await t.page.fill('#pa-name', orgName);
    await t.page.click('#pa-go');
    await t.page.locator('.modal h2', { hasText: 'Check your email' }).waitFor();
    assert.equal((await admin.get(`/api/orgs/${orgId}`)).status, 200, 'still there until confirmed');
    t.assertNoErrors();
    await t.close();
  });

  it('tenant users are sent to the org home', async () => {
    const user = await inviteAndJoin(admin, orgId, 'ui-oa-user');
    const t = await pageAs(user);
    for (const v of ['security', 'audit', 'settings']) {
      await t.page.goto(`/o/${orgId}/${v}`);
      await settled(t.page);
      assert.equal(new URL(t.page.url()).pathname, `/o/${orgId}`, v);
    }
    t.assertNoErrors();
    await t.close();
  });

  it('phone width: security and audit fit without sideways scroll', async () => {
    const t = await pageAs(admin, { viewport: { width: 390, height: 800 } });
    for (const v of ['security', 'audit', 'settings']) {
      await t.page.goto(`/o/${orgId}/${v}`);
      await settled(t.page);
      await assertNoHorizontalScroll(t.page);
    }
    t.assertNoErrors();
    await t.close();
  });
});

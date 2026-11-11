// Org instances: list with filters, create with live progress, detail (rename, teams, sign-in
// policy with and without lock-out, delete with typed name + passkey + email), tenant-user view.
// UI_SHOTS=<dir> also writes screenshots (light and dark) of each view.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { Person, addToTeam, createTeam, expectStatus, inviteAndJoin, newTenant } from '../e2e/lib/flows.mjs';
import { mailMark, waitForMail } from '../e2e/lib/mail.mjs';
import { addVirtualAuthenticator, assertNoHorizontalScroll, closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();
const SHOTS = process.env.UI_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function shoot(person, path, name, { viewport, ready } = {}) {
  if (!SHOTS) return;
  for (const colorScheme of ['light', 'dark']) {
    const t = await pageAs(person, { colorScheme, ...(viewport ? { viewport } : {}) });
    await t.page.goto(path);
    await settled(t.page);
    if (ready) await ready(t.page);
    await t.page.screenshot({ path: `${SHOTS}/${name}-${colorScheme}.png`, fullPage: true });
    await t.close();
  }
}

/** Copies the e2e person's (JS) passkey into the page's CDP virtual authenticator. */
async function importPasskey(page, person) {
  const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
  for (const c of person.authenticator.credentials) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: Buffer.from(c.id).toString('base64'),
        isResidentCredential: true,
        rpId: c.rpId,
        privateKey: c.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: c.userHandle ? Buffer.from(c.userHandle, 'base64url').toString('base64') : undefined,
        signCount: c.signCount,
      },
    });
  }
}

describe('org instances', { skip }, () => {
  let admin, orgId, teamId, member, inst;
  const name = `UI box ${Date.now().toString(36)}`;

  before(async () => {
    ({ admin, orgId } = await newTenant('ui-inst'));
    teamId = await createTeam(admin, orgId, 'Builders');
    member = await inviteAndJoin(admin, orgId, 'ui-inst-member');
    await addToTeam(admin, orgId, teamId, member.id);
  });
  after(closeBrowser);

  it('empty list, then create: the detail shows the steps until it runs', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances`);
    await settled(t.page);
    assert.ok(await t.page.getByText('No instances yet').isVisible());
    await shoot(admin, `/o/${orgId}/instances`, 'list-empty');
    await shoot(admin, `/o/${orgId}/instances/new`, 'create');

    await t.page.locator('.inst-empty a', { hasText: 'New instance' }).click();
    await settled(t.page);
    assert.match(await t.page.locator('#c-limit').innerText(), /1 of 1/);
    await t.page.click('#c-go');
    // A field's problem shows under that field, as in worca: red border, aria-invalid, focus.
    const nameErr = t.page.locator('#c-name').locator('xpath=..').locator('.field-error');
    assert.match(await nameErr.innerText(), /Give it a name/);
    assert.equal(await t.page.locator('#c-name').getAttribute('aria-invalid'), 'true');
    assert.ok(await t.page.locator('#c-err').isHidden());
    // The org's only team is picked already (D71).
    assert.equal(await t.page.locator('#c-team').inputValue(), teamId);
    await t.page.fill('#c-name', name);
    await t.page.click('#c-go');
    await t.page.waitForURL(new RegExp(`/o/${orgId}/instances/[0-9a-f-]{36}$`));
    await settled(t.page);
    const id = new URL(t.page.url()).pathname.split('/').pop();
    assert.equal(await t.page.locator('#inst-name').innerText(), name);
    assert.ok(await t.page.locator('.inst-steps .step').count() >= 5, 'the create phases are listed');
    assert.equal(await t.page.locator('.inst-steps [data-phase="reserving"]').count(), 1);
    if (SHOTS) await t.page.screenshot({ path: `${SHOTS}/progress-light.png`, fullPage: true });
    // The fake provider in the local stack runs it within ~20 s; the page polls every 5 s.
    await t.page.waitForFunction(() => document.querySelector('#inst-state')?.textContent === 'Running', null, { timeout: 90_000 });
    assert.equal(await t.page.locator('.inst-steps [data-phase="ready"][data-state="done"]').count(), 1, 'all steps done');
    assert.ok(await t.page.locator('a.btn', { hasText: 'Open' }).isVisible());
    // Region and resources as the (fake) provider reports them, read right after the first heartbeat.
    await t.page.waitForFunction(() => document.querySelector('#inst-region')?.textContent === 'EU West (Amsterdam)', null, { timeout: 40_000 });
    assert.match(await t.page.locator('#inst-resources').innerText(), /Worca 2 vCPU · 4 GB · 50 GB volume\s+Broker 2 vCPU · 4 GB · 50 GB volume\s+Tunnel 2 vCPU · 4 GB/);
    assert.equal(await t.page.locator('#inst-region-note').count(), 0);
    inst = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${id}`), 200).json();
    t.assertNoErrors();
    await t.close();
  });

  it('the plan is full: the form explains it and cannot be sent', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/new`);
    await settled(t.page);
    assert.match(await t.page.locator('#c-limit').innerText(), /plan is full/);
    assert.ok(await t.page.locator('#c-go').isDisabled());
    t.assertNoErrors();
    await t.close();
  });

  it('list: the instance with its host, status and teams; status and team filters', async () => {
    const other = await createTeam(admin, orgId, 'Bystanders');
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances`);
    await settled(t.page);
    const row = t.page.locator(`tr[data-instance="${inst.id}"]`);
    assert.match(await row.innerText(), new RegExp(`${name}[\\s\\S]*${inst.host.replace(/\./g, '\\.')}[\\s\\S]*Running[\\s\\S]*Builders`));
    // The instance's teams link to them (teams first, D71).
    assert.equal(await row.locator(`a.inst-teampill[href="/o/${orgId}/teams/${teamId}"]`).count(), 1);
    await t.page.click('[data-status="suspended"]');
    assert.equal(await row.count(), 0);
    assert.ok(await t.page.getByText('No instances match these filters').isVisible());
    assert.match(t.page.url(), /status=suspended/);
    await t.page.click('[data-status="running"]');
    assert.equal(await row.count(), 1);
    await t.page.selectOption('#inst-team', other);
    assert.equal(await row.count(), 0);
    await t.page.selectOption('#inst-team', teamId);
    assert.equal(await row.count(), 1);
    assert.match(t.page.url(), new RegExp(`team=${teamId}`));
    await row.click();
    await t.page.waitForURL(new RegExp(`/instances/${inst.id}$`));
    await shoot(admin, `/o/${orgId}/instances`, 'list');
    t.assertNoErrors();
    await t.close();
  });

  it('detail: rename and change the teams', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    await t.page.click('#rename');
    await t.page.fill('#rn-name', `${name} 2`);
    await t.page.click('#rn-go');
    await t.page.waitForFunction((n) => document.querySelector('#inst-name')?.textContent === n, `${name} 2`);
    inst.name = `${name} 2`;

    await t.page.click('#edit-teams');
    await t.page.locator('.modal label.check', { hasText: 'Bystanders' }).click();
    await t.page.click('#tm-go');
    await t.page.waitForFunction(() => /Builders, Bystanders|Bystanders, Builders/.test(document.querySelector('#edit-teams')?.textContent || ''));
    const now = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json();
    assert.equal(now.teamIds.length, 2);

    // An instance always keeps a team (D71): unticking them all is refused in the dialog.
    await t.page.click('#edit-teams');
    await t.page.locator('#tm-go').waitFor();
    const ticked = t.page.locator('.modal label.check', { has: t.page.locator('input:checked') });
    while (await ticked.count()) await ticked.first().click();
    assert.equal(await t.page.locator('.modal input[name=team]:checked').count(), 0);
    await t.page.click('#tm-go');
    const teamsErr = t.page.locator('.modal .field-error');
    await teamsErr.waitFor();
    assert.match(await teamsErr.innerText(), /always keeps at least one team/);
    assert.equal(await t.page.locator('.modal input[name=team]').first().getAttribute('aria-invalid'), 'true');
    await t.page.click('.modal [data-close]');
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json().teamIds.length, 2);
    t.assertNoErrors();
    await t.close();
  });

  it('detail: automatic updates are on for a new instance; the admin turns them off and on', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    const row = t.page.locator('#auto-update-row');
    assert.match(await row.innerText(), /Automatic updates[\s\S]*Install micro releases \(x\.y\.Z\) automatically while the instance is idle/);
    assert.equal(await t.page.locator('#auto-update').isChecked(), true);
    await row.click();
    await t.page.waitForFunction(() => document.querySelector('#auto-update') && !document.querySelector('#auto-update').checked && !document.querySelector('#auto-update').disabled);
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json().autoUpdate, 'off');
    // Minor releases (D75) need micro: off and disabled while micro is off.
    assert.equal(await t.page.locator('#auto-update-minor').isDisabled(), true);
    assert.match(await t.page.locator('#auto-update-minor-row').innerText(), /Minor releases too[\s\S]*Needs micro releases on/);
    await t.page.locator('#auto-update-row').click();
    await t.page.waitForFunction(() => document.querySelector('#auto-update')?.checked && !document.querySelector('#auto-update').disabled);
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json().autoUpdate, 'micro');
    // Minor is off for a new instance; turning it on is mode 'minor'.
    assert.equal(await t.page.locator('#auto-update-minor').isChecked(), false);
    assert.match(await t.page.locator('#auto-update-minor-row').innerText(), /can change how Worca stores its data/);
    await t.page.locator('#auto-update-minor-row').click();
    await t.page.waitForFunction(() => document.querySelector('#auto-update-minor')?.checked && !document.querySelector('#auto-update-minor').disabled);
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json().autoUpdate, 'minor');
    // Micro off turns both off.
    await t.page.locator('#auto-update-row').click();
    await t.page.waitForFunction(() => document.querySelector('#auto-update') && !document.querySelector('#auto-update').checked && document.querySelector('#auto-update-minor')?.disabled);
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json().autoUpdate, 'off');
    assert.equal(await t.page.locator('#auto-update-minor').isChecked(), false);
    // Back to micro only, as the later tests expect.
    expectStatus(await admin.put(`/api/orgs/${orgId}/instances/${inst.id}/auto-update`, { mode: 'micro' }), 200);
    t.assertNoErrors();
    await t.close();
  });

  it('detail: remote access in Worca (D72): switches, warning, confirmation step, restart, then off again', async () => {
    const api = async () => expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200);
    const settledOp = async () => {
      for (let i = 0; i < 60; i++) {
        const now = (await api()).json();
        if (now.op?.kind === 'reconfigure' && now.op.status !== 'running') return now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('the reconfigure operation did not finish');
    };
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    assert.match(await t.page.locator('#edit-remote').innerText(), /Remote access in Worca[\s\S]*Terminal and actions off/);
    await t.page.click('#edit-remote');
    await t.page.waitForSelector('#ra-terminal');
    assert.match(await t.page.locator('#ra-warning').innerText(), /shell or commands that run as the Worca server, with access to its settings and environment[\s\S]*restarts Worca: active runs pause and resume/);
    assert.ok(await t.page.locator('#ra-next').isDisabled(), 'nothing changed yet');
    await t.page.locator('label[for="ra-terminal"]').click();
    await t.page.click('#ra-next');
    assert.match(await t.page.locator('#ra-summary').innerText(), /the terminal will be on for everyone/i);
    await t.page.click('#ra-go');
    await t.page.waitForFunction(() => /Terminal on, actions off/.test(document.querySelector('#remote-line')?.textContent || ''));
    const on = await settledOp();
    assert.deepEqual(on.remoteAccess, { terminal: true, actions: false, pending: false });
    assert.equal(on.op.status, 'done');

    await t.page.reload();
    await settled(t.page);
    await t.page.click('#edit-remote');
    await t.page.locator('label[for="ra-terminal"]').click();
    await t.page.click('#ra-next');
    assert.match(await t.page.locator('#ra-summary').innerText(), /will be off/);
    await t.page.click('#ra-go');
    await t.page.waitForFunction(() => /Terminal and actions off/.test(document.querySelector('#remote-line')?.textContent || ''));
    assert.deepEqual((await settledOp()).remoteAccess, { terminal: false, actions: false, pending: false });
    t.assertNoErrors();
    await t.close();
  });

  it('detail: outbound network (D73): same as the org, an own policy that restarts Worca, then back to the org', async () => {
    const api = async () => expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json();
    const settledOp = async (since) => {
      for (let i = 0; i < 60; i++) {
        const now = await api();
        if (now.op?.kind === 'reconfigure' && now.op.startedAt >= since && now.op.status !== 'running') return now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('the reconfigure operation did not finish');
    };
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    assert.match(await t.page.locator('#edit-egress').innerText(), /Outbound network[\s\S]*Open: agents can reach any host · Same as the org/);
    await t.page.click('#edit-egress');
    await t.page.waitForSelector('input[name="ie-src"]');
    assert.ok(await t.page.locator('#ie-next').isDisabled(), 'nothing changed yet');
    assert.equal(await t.page.locator('#ie-own').isVisible(), false);
    await t.page.locator('input[name="ie-src"][value="own"]').check();
    await t.page.locator('input[name="ie-mode"][value="block"]').check();
    await t.page.fill('#ie-deny', 'pastebin.com');
    await t.page.click('#ie-next');
    assert.match(await t.page.locator('#ie-summary').innerText(), /gets its own policy: Open except 1 blocked host\. Worca restarts now/);
    const since = Date.now() - 5000;
    await t.page.click('#ie-go');
    await t.page.waitForFunction(() => /Own policy for this instance/.test(document.querySelector('#egress-line')?.textContent || ''));
    const done = await settledOp(since);
    assert.equal(done.op.status, 'done');
    const eg = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/egress`), 200).json();
    assert.deepEqual(eg.effective, { mode: 'block', allow: [], deny: ['pastebin.com'] });
    assert.equal(eg.pending, false);

    // A bad entry is refused under its list, back in the editing step.
    await t.page.reload();
    await settled(t.page);
    await t.page.click('#edit-egress');
    await t.page.fill('#ie-deny', 'pastebin.com\nnot a host');
    await t.page.click('#ie-next');
    await t.page.click('#ie-go');
    await t.page.locator('#ie-deny-f .field-error').waitFor();
    assert.equal(await t.page.locator('#ie-pick').isVisible(), true);

    // Back to the org's policy.
    await t.page.locator('input[name="ie-src"][value="org"]').check();
    await t.page.click('#ie-next');
    assert.match(await t.page.locator('#ie-summary').innerText(), /follows the org's policy again/);
    const since2 = Date.now() - 5000;
    await t.page.click('#ie-go');
    await t.page.waitForFunction(() => /Same as the org/.test(document.querySelector('#egress-line')?.textContent || ''));
    await settledOp(since2);
    assert.equal(expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/egress`), 200).json().inherited, true);
    t.assertNoErrors();
    await t.close();
  });

  it('detail: git credentials (D79): not set, an Azure DevOps token, identity and clone list that restart Worca; secrets never shown; a bad entry under its field', async () => {
    const api = async () => expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json();
    const settledOp = async (since) => {
      for (let i = 0; i < 60; i++) {
        const now = await api();
        if (now.op?.kind === 'reconfigure' && now.op.startedAt >= since && now.op.status !== 'running') return now;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('the reconfigure operation did not finish');
    };
    const PAT = `ado-pat-${Date.now().toString(36)}-wxyz`;
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    assert.match(await t.page.locator('#edit-git').innerText(), /Git credentials[\s\S]*No credential of the instance: members use their own GitHub/);
    await t.page.click('#edit-git');
    await t.page.waitForSelector('input[name="gt-gh"]');
    assert.equal(await t.page.locator('#gt-app').isVisible(), false);
    assert.equal(await t.page.locator('#gt-ado-f').isVisible(), false);
    await t.page.locator('input[name="gt-az"][value="pat"]').check();
    await t.page.fill('#gt-ado', PAT);
    await t.page.fill('#gt-id-name', 'Acme Worca');
    await t.page.fill('#gt-id-email', 'worca@acme.test');
    // A bad clone entry comes back under its field, in the editing step.
    await t.page.fill('#gt-clone', 'github.com');
    await t.page.click('#gt-next');
    await t.page.click('#gt-go');
    await t.page.locator('.field:has(#gt-clone) .field-error').waitFor();
    assert.equal(await t.page.locator('#gt-pick').isVisible(), true);
    await t.page.fill('#gt-clone', 'dev.azure.com/acme/*');
    await t.page.click('#gt-next');
    assert.match(await t.page.locator('#gt-summary').innerText(), /Worca restarts now/);
    const since = Date.now() - 5000;
    await t.page.click('#gt-go');
    await t.page.waitForFunction(() => /Azure DevOps/.test(document.querySelector('#git-line')?.textContent || ''));
    const done = await settledOp(since);
    assert.equal(done.op.status, 'done');
    const git = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/git`), 200).json();
    assert.deepEqual({ azure: git.azure.last4, identity: git.identity, cloneAllow: git.cloneAllow, pending: git.pending }, { azure: 'wxyz', identity: { name: 'Acme Worca', email: 'worca@acme.test' }, cloneAllow: ['dev.azure.com/acme/*'], pending: false });
    assert.ok(!JSON.stringify(git).includes(PAT), 'the token never comes back');

    // Reopened: the token field is empty and says what is stored.
    await t.page.reload();
    await settled(t.page);
    await t.page.click('#edit-git');
    assert.equal(await t.page.inputValue('#gt-ado'), '');
    assert.match(await t.page.locator('#gt-ado-f .hint').innerText(), /Stored \(…wxyz\)/);
    assert.ok(!(await t.page.content()).includes(PAT));
    await t.page.click('[data-close]');
    t.assertNoErrors();
    await t.close();
  });

  it('detail: "Change version" lists the published versions, the current one marked and not choosable', async () => {
    const versions = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}/versions`), 200).json();
    assert.ok(versions.versions.length >= 1);
    assert.equal(versions.versions.filter((v) => v.latest).length, 1, 'exactly one latest');
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    await t.page.waitForFunction((v) => document.querySelector('#inst-version')?.textContent === v, versions.current, { timeout: 40_000 });
    await t.page.click('#change-version');
    await t.page.waitForSelector('#up-version');
    const labels = (await t.page.locator('#up-version option').allInnerTexts()).map((x) => x.trim());
    assert.deepEqual(labels, versions.versions.map((v) => [v.version, v.latest ? 'latest' : '', v.current ? 'current' : ''].filter(Boolean).join(' · ')));
    assert.equal(await t.page.locator('#up-version').inputValue(), versions.latest, 'the latest is preselected');
    const cur = versions.versions.find((v) => v.current);
    if (cur) {
      await t.page.selectOption('#up-version', cur.version);
      assert.ok(await t.page.locator('#up-go').isDisabled(), 'the running version cannot be chosen');
      assert.ok(await t.page.locator('#up-older').isHidden());
    }
    const older = versions.versions.find((v) => v.direction === 'downgrade');
    if (older) {
      await t.page.selectOption('#up-version', older.version);
      assert.ok(await t.page.locator('#up-older').isVisible(), 'an older version shows the warning');
      assert.equal((await t.page.locator('#up-go').innerText()).trim(), `Change to ${older.version}`);
    }
    if (SHOTS) await t.page.screenshot({ path: `${SHOTS}/change-version-light.png` });
    await t.page.click('.modal [data-close]');
    t.assertNoErrors();
    await t.close();
  });

  it('sign-in policy: a change that locks nobody out applies; one that does lists the members first', async () => {
    const t = await pageAs(admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    assert.match(await t.page.locator('#policy-line').innerText(), /Org default/);

    // Email code and passkey: the member signs in with an email code, so nobody is affected.
    await t.page.click('#edit-policy');
    await t.page.check('.modal input[name=pp][value=only]');
    await t.page.check('.modal input[name=pm][value=email-otp]');
    await t.page.check('.modal input[name=pm][value=passkey]');
    await t.page.click('#pp-go');
    await t.page.waitForFunction(() => /Only Email code or Passkey/.test(document.querySelector('#policy-line')?.textContent || ''));

    // Passkey only: the member would be locked out, so the dialog names them and asks for the name.
    await t.page.click('#edit-policy');
    await t.page.uncheck('.modal input[name=pm][value=email-otp]');
    await t.page.click('#pp-go');
    await t.page.waitForSelector('#pa-name');
    assert.match(await t.page.locator('.modal').innerText(), new RegExp(`1 member would lose access[\\s\\S]*${member.email.replace(/[.+]/g, '\\$&')}`, 'i'));
    if (SHOTS) await t.page.screenshot({ path: `${SHOTS}/policy-lockout-light.png` });
    assert.ok(await t.page.locator('#pa-go').isDisabled());
    const before = await mailMark(admin.email);
    await t.page.fill('#pa-name', inst.name);
    await t.page.click('#pa-go');
    await t.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    await waitForMail(admin.email, { after: before, match: (m) => /confirm/i.test(m.subject) });
    await t.page.click('.modal [data-close]');
    assert.match(await t.page.locator('#policy-line').innerText(), /Only Email code or Passkey/, 'unchanged until confirmed');
    t.assertNoErrors();
    await t.close();
  });

  it('tenant user: read-only detail of a granted instance; no list, no create', async () => {
    const t = await pageAs(member);
    await t.page.goto(`/o/${orgId}/instances/new`);
    await settled(t.page);
    assert.equal(new URL(t.page.url()).pathname, `/o/${orgId}`);
    await t.page.goto(`/o/${orgId}/instances`);
    await settled(t.page);
    assert.equal(new URL(t.page.url()).pathname, `/o/${orgId}`);

    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);
    assert.equal(await t.page.locator('#inst-name').innerText(), inst.name);
    for (const sel of ['#rename', '#del', '#edit-teams', '#edit-policy', '#upgrade', '#change-version', '#edit-remote', '#edit-egress', '#edit-git']) assert.equal(await t.page.locator(sel).count(), 0, sel);
    assert.match(await t.page.locator('.inst-sections').innerText(), /Builders/);
    // D79: members' own GitHub, by default; the key page link is theirs to follow.
    assert.match(await t.page.locator('#git-line').innerText(), /Worca clones, pushes and opens pull requests as you once you paste a GitHub token on the key page/);
    assert.match(await t.page.locator('#git-line a').getAttribute('href'), /^http/);
    // Automatic updates: the state, no switch.
    assert.equal(await t.page.locator('#auto-update').count(), 0);
    assert.equal(await t.page.locator('#auto-update-state').innerText(), 'On');
    assert.equal(await t.page.locator('#auto-update-minor').count(), 0);
    assert.equal(await t.page.locator('#auto-update-minor-state').innerText(), 'Off');
    assert.match(await t.page.locator('#remote-row').innerText(), /Remote access in Worca[\s\S]*Terminal and actions off/);
    // Outbound network (D73): read-only.
    assert.match(await t.page.locator('#egress-row').innerText(), /Outbound network[\s\S]*Same as the org/);
    assert.equal(await t.page.locator('.inst-crumb a').getAttribute('href'), `/o/${orgId}`);
    await shoot(member, `/o/${orgId}/instances/${inst.id}`, 'detail-user');
    t.assertNoErrors();
    await t.close();
  });

  it('phone width: list and detail without sideways scrolling', async () => {
    const viewport = { width: 390, height: 800 };
    for (const path of [`/o/${orgId}/instances`, `/o/${orgId}/instances/${inst.id}`, `/o/${orgId}/instances/new`]) {
      const t = await pageAs(admin, { viewport });
      await t.page.goto(path);
      await settled(t.page);
      await assertNoHorizontalScroll(t.page);
      t.assertNoErrors();
      await t.close();
    }
    await shoot(admin, `/o/${orgId}/instances/${inst.id}`, 'detail-phone', { viewport });
    await shoot(admin, `/o/${orgId}/instances/${inst.id}`, 'detail');
  });

  it('delete: typed name, then the passkey step, then "check your email"', async () => {
    // The same admin, signed in with an email code this time (no MFA), with their passkey on the device.
    const again = new Person(admin.email, 'ui-inst-admin-otp');
    again.authenticator = admin.authenticator;
    expectStatus(await again.signInWithCode(), 200, 'email-code sign-in');
    assert.equal((await again.me()).session.mfa, false);
    const t = await pageAs(again);
    await importPasskey(t.page, admin);
    await t.page.goto(`/o/${orgId}/instances/${inst.id}`);
    await settled(t.page);

    await t.page.click('#del');
    await t.page.waitForSelector('#pa-name');
    assert.ok(await t.page.locator('#pa-go').isDisabled());
    await t.page.fill('#pa-name', 'not the name');
    assert.ok(await t.page.locator('#pa-go').isDisabled());
    await t.page.fill('#pa-name', inst.name);
    if (SHOTS) await t.page.screenshot({ path: `${SHOTS}/delete-typed-light.png` });
    await t.page.click('#pa-go');
    await t.page.getByRole('heading', { name: 'Confirm with your passkey' }).waitFor();
    const before = await mailMark(admin.email);
    await t.page.click('#su-go');
    await t.page.getByRole('heading', { name: 'Check your email' }).waitFor();
    const mail = await waitForMail(admin.email, { after: before, match: (m) => /confirm/i.test(m.subject) });
    assert.match(mail.text, new RegExp(inst.name));
    await t.page.click('.modal [data-close]');
    const still = expectStatus(await admin.get(`/api/orgs/${orgId}/instances/${inst.id}`), 200).json();
    // Running, or suspended by E2E_FAST's 20 s idle timer when the tests before ran slowly; not deleting.
    assert.ok(['running', 'suspended'].includes(still.status), `nothing happens before the emailed link is confirmed (status ${still.status})`);
    t.assertNoErrors();
    await t.close();
  });
});

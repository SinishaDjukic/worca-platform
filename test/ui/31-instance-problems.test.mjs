// The instance page explains provider failures in plain words: a step that keeps failing while it
// is retried, and a create that stopped. The API answer is rewritten in the browser, since the local
// providers never fail on their own.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skipUnlessUp } from '../e2e/lib/config.mjs';
import { createRunningInstance, newTenant } from '../e2e/lib/flows.mjs';
import { closeBrowser, pageAs, settled } from './lib.mjs';

const skip = await skipUnlessUp();

describe('instance problems', { skip }, () => {
  let fx;
  before(async () => {
    const { admin, orgId } = await newTenant('ui-prob');
    const inst = await createRunningInstance(admin, orgId, { name: 'Problems' });
    fx = { admin, orgId, inst };
  });
  after(closeBrowser);

  /** Opens the detail page with the instance's API answer changed by `patch`. */
  async function openWith(patch) {
    const t = await pageAs(fx.admin);
    await t.page.route(`**/api/orgs/${fx.orgId}/instances/${fx.inst.id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: patch(body) });
    });
    await t.page.goto(`/o/${fx.orgId}/instances/${fx.inst.id}`);
    await settled(t.page);
    return t;
  }

  const creating = (extra) => (b) => {
    const op = { kind: 'create', phase: 'compute', phases: ['reserving', 'compute', 'network', 'starting', 'waiting', 'ready'], status: 'running', startedAt: Date.now() - 60_000, phaseStartedAt: Date.now() - 60_000, finishedAt: null, problem: null, problemSource: null };
    return Object.assign(b, { status: 'creating', error: null, errorReason: null, errorSource: null, op }, extra(op));
  };

  it('a step that keeps failing says why, and that it is retried', async () => {
    const t = await openWith(creating((op) => (Object.assign(op, { problem: 'provider_limit', problemSource: 'compute' }), {})));
    const step = t.page.locator('.inst-steps .step[data-state="current"]');
    assert.match(await step.innerText(), /Creating its compute/);
    const line = await step.locator('.step-problem').innerText();
    assert.match(line, /Our hosting provider is refusing to create more machines right now: the platform's account has reached a limit\. Retrying/);
    assert.doesNotMatch(line, /railway|station/i, 'never the provider\'s own text');
    t.assertNoErrors();
    await t.close();
  });

  it('a create that stopped: no spinner, "Setup stopped", and the reason', async () => {
    const t = await openWith(creating((op) => (Object.assign(op, { status: 'failed' }), { error: 'create_failed', errorReason: 'provider_limit', errorSource: 'compute' })));
    assert.equal(await t.page.locator('#inst-state').innerText(), 'Setup stopped');
    const g = t.page.locator('.inst-status-top .g').first();
    assert.doesNotMatch(await g.getAttribute('class'), /\bspin\b/, 'no spinner once setup stopped');
    assert.match(await g.getAttribute('class'), /\bred\b/);
    const banner = await t.page.locator('#inst-error').innerText();
    assert.match(banner, /Setup stopped\. Our hosting provider is refusing to create more machines right now/);
    assert.match(banner, /Delete it and create it again later\./);
    assert.equal(await t.page.locator('.inst-steps .step[data-state="failed"]').count(), 1);
    t.assertNoErrors();
    await t.close();
  });
});

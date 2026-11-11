// Org SSO (D22) against a fake OIDC provider on the loopback interface (LOCAL_DEV allows http
// there): a tenant admin registers a connector through discovery, and a person on the org's
// domain signs in through it: /api/auth/sign-in/sso -> IdP authorize -> /api/auth/sso/callback.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { skipUnlessUp } from './lib/config.mjs';
import { startFakeIdp } from './lib/fake-idp.mjs';
import { AUTH, expectStatus, newTenant, Person } from './lib/flows.mjs';

const skip = await skipUnlessUp();

/** Domain verification needs real DNS: the test marks the domain verified in the local D1. */
function markVerified(domainId) {
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'worca-platform-db-dev', '--local', '-c', 'wrangler.control.jsonc', '--env', 'dev', '--persist-to', process.env.PERSIST_TO || '.wrangler/state', '--command',
      `UPDATE org_domains SET verified_at = ${Date.now()} WHERE id = '${domainId.replace(/'/g, "''")}'`],
    { cwd: new URL('../..', import.meta.url), stdio: 'pipe' },
  );
}

describe('org SSO through an OIDC provider', { skip }, () => {
  let idp, admin, orgId, domain, providerId;

  before(async () => {
    idp = await startFakeIdp();
    ({ admin, orgId } = await newTenant('sso-admin'));
    domain = `sso-${Date.now()}.e2e.test`;
    const d = expectStatus(await admin.post(`/api/orgs/${orgId}/domains`, { domain }), 201, 'add domain').json();
    markVerified(d.id);
    providerId = `sso-e2e-${Date.now().toString(36)}`;
  });
  after(() => idp?.close());

  it('refuses an http IdP that is not on the loopback interface', async () => {
    const res = await admin.post(`/api/orgs/${orgId}/sso`, { type: 'oidc', domainId: (await domainId()), issuer: 'http://idp.example', config: { clientId: 'c', clientSecret: 's' } });
    assert.equal(res.status, 400, res.describe());
    assert.equal(res.json().error, 'idp_url_not_allowed');
  });

  it('registers the connector through discovery', async () => {
    const res = await admin.post(`/api/orgs/${orgId}/sso`, {
      type: 'oidc', domainId: await domainId(), providerId, issuer: idp.issuer, config: { clientId: idp.clientId, clientSecret: idp.clientSecret },
    });
    expectStatus(res, 201, 'register sso');
    assert.equal(res.json().redirectUrl, `${AUTH}/sso/callback/${providerId}`);
    const list = expectStatus(await admin.get(`/api/orgs/${orgId}/sso`), 200).json();
    assert.deepEqual(list.providers.map((p) => [p.providerId, p.type, p.status, p.domain]), [[providerId, 'oidc', 'active', domain]]);
  });

  it('signs a person on the domain in and makes them a tenant user of the org', async () => {
    const bob = new Person(`bob@${domain}`);
    idp.nextUser = { email: bob.email, name: 'Bob' };
    const start = expectStatus(await bob.post(`${AUTH}/sign-in/sso`, { email: bob.email, callbackURL: '/' }), 200, 'sign-in/sso');
    const authorize = new URL(start.json().url);
    assert.equal(authorize.origin, idp.issuer);
    // IdP authorize -> our callback -> the callbackURL; stop at the callback's answer.
    const { hops, final } = await bob.browser.navigate(authorize.href, { stopAt: (r) => r.url.includes('/sso/callback/') });
    assert.ok(hops.some((h) => h.url.includes(`/api/auth/sso/callback/${providerId}`)), hops.map((h) => `${h.status} ${h.url}`).join('\n'));
    assert.equal(final.status, 302, final.describe());
    assert.equal(idp.tokenRequests > 0, true);
    const me = await bob.me();
    assert.equal(me?.user?.email, bob.email, JSON.stringify(me));
    assert.equal(me.session.method, 'sso');
    assert.deepEqual(me.orgs.map((o) => [o.id, o.role]), [[orgId, 'tenant_user']]);
  });

  // That registering an IdP doesn't make its origin a redirect target is covered by the unit
  // tests (sso-register.test.ts): here the loopback IdP is trusted anyway (LOCAL_DEV origins).

  let cachedDomainId;
  async function domainId() {
    cachedDomainId ??= expectStatus(await admin.get(`/api/orgs/${orgId}/domains`), 200).json().domains.find((d) => d.domain === domain).id;
    return cachedDomainId;
  }
});

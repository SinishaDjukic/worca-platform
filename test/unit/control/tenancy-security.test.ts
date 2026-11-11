// Org sign-in security (ui-feasibility.md T11): SSO read and delete, and the D31 lock-out check
// for login policy changes, which names the members it would lock out.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readOrgAudit } from '../../../packages/platform/src/control/tenancy/audit';
import {
  addMember,
  ensureTables,
  type Fakes,
  gateCalls,
  harness,
  insertRow,
  installFakes,
  lastConfirmLink,
  resetGate,
  seedInstance,
  seedOrg,
  seedTeam,
  seedUser,
  type TestUser,
  testEnv,
} from './helpers/tenancy-fixtures';

let fakes: Fakes;
let tag = '';
const call = harness();

beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  await resetGate();
  tag = crypto.randomUUID().slice(0, 8); // emails are unique across the file's tests
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const future = () => new Date(Date.now() + 3_600_000).toISOString();

interface Affected {
  id: string;
  name: string | null;
  email: string | null;
  reasons: string[];
  instanceIds: string[];
}

/** An SSO provider row as the adapter wrapper stores it: domain and config encrypted with the org key. */
async function seedSso(orgId: string, opts: { domain: string; type?: 'oidc' | 'saml'; providerId?: string; verified?: boolean; admin?: TestUser }) {
  const id = crypto.randomUUID();
  const providerId = opts.providerId ?? `sso-${id.slice(0, 8)}`;
  const owner = { type: 'org' as const, id: orgId };
  const enc = (column: string, v: string) => fakes.ring.encrypt({ table: 'ssoProvider', column, rowId: id, owner }, v);
  const oidc = JSON.stringify({ clientId: 'cid', clientSecret: 'super-secret-value', tokenEndpoint: 'https://idp.example/token' });
  const saml = JSON.stringify({ entryPoint: 'https://idp.example/saml', cert: 'CERT-PRIVATE-MATERIAL', privateKey: 'PRIVATE-KEY-PEM' });
  await insertRow('ssoProvider', {
    id,
    issuer: 'https://idp.example',
    oidcConfig: opts.type === 'saml' ? null : await enc('oidcConfig', oidc),
    samlConfig: opts.type === 'saml' ? await enc('samlConfig', saml) : null,
    userId: opts.admin?.id ?? null,
    providerId,
    organizationId: orgId,
    domain: await enc('domain', opts.domain),
    domainIndex: await fakes.ring.blindIndex(opts.domain),
    domainVerified: opts.verified === false ? 0 : 1,
    createdAt: Date.now(),
  });
  return { id, providerId };
}

async function seedSession(user: TestUser, opts: { method: string; ssoOrgId?: string | null; createdAt?: number }) {
  const id = crypto.randomUUID();
  const at = new Date(opts.createdAt ?? Date.now()).toISOString();
  await insertRow('session', {
    id,
    userId: user.id,
    token: `h1.${id}`,
    expiresAt: future(),
    createdAt: at,
    updatedAt: at,
    method: opts.method,
    ssoOrgId: opts.ssoOrgId ?? null,
    mfa: opts.method === 'passkey' ? 1 : 0,
  });
  return id;
}

async function seedPasskey(user: TestUser) {
  await insertRow('passkey', { id: crypto.randomUUID(), name: 'k', publicKey: 'pk', userId: user.id, credentialID: crypto.randomUUID(), counter: 0, deviceType: 'singleDevice', backedUp: 0 });
}

async function setPolicy(orgId: string, admin: TestUser, allowedMethods: string[], requiredDomain: string | null = null) {
  const res = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { allowedMethods, requiredDomain } });
  expect(res.status).toBe(200);
}

describe('SSO read (T11)', () => {
  it('lists the org providers with their redirect URL and never their settings', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com` });
    const orgId = await seedOrg(fakes, admin);
    const oidc = await seedSso(orgId, { domain: 'acme.com', providerId: 'acme-okta', admin });
    const saml = await seedSso(orgId, { domain: 'acme.net', type: 'saml', providerId: 'acme-saml', verified: false, admin });
    const other = await seedOrg(fakes, await seedUser(fakes), 'Other');
    await seedSso(other, { domain: 'other.com', providerId: 'other-sso' });

    const res = await call('GET', `/api/orgs/${orgId}/sso`, { as: admin });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of ['super-secret-value', 'clientSecret', 'CERT-PRIVATE-MATERIAL', 'PRIVATE-KEY-PEM', 'oidcConfig', 'samlConfig', 'enc:v1:', 'domainIndex', 'other-sso']) {
      expect(text).not.toContain(secret);
    }
    const { providers } = JSON.parse(text) as { providers: Record<string, unknown>[] };
    const origin = new URL(testEnv.APP_ORIGIN).origin;
    expect(providers).toHaveLength(2);
    expect(providers.find((p) => p.id === oidc.id)).toEqual({
      id: oidc.id,
      providerId: 'acme-okta',
      type: 'oidc',
      issuer: 'https://idp.example',
      domain: 'acme.com',
      createdAt: expect.any(Number),
      status: 'active',
      redirectUrl: `${origin}/api/auth/sso/callback/acme-okta`,
    });
    expect(providers.find((p) => p.id === saml.id)).toMatchObject({
      type: 'saml',
      domain: 'acme.net',
      status: 'domain_unverified',
      redirectUrl: `${origin}/api/auth/sso/saml2/sp/acs/acme-saml`,
      metadataUrl: `${origin}/api/auth/sso/saml2/sp/metadata?providerId=acme-saml`,
    });

    const user = await seedUser(fakes);
    await addMember(orgId, user);
    expect((await call('GET', `/api/orgs/${orgId}/sso`, { as: user })).status).toBe(403);
    expect((await call('GET', `/api/orgs/${orgId}/sso`, { as: await seedUser(fakes) })).status).toBe(404);
  });

  it('registration records createdAt and returns the redirect URL', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'acme.dev' } }));
    fakes.dns.set(d.txtName, [d.txtValue]);
    await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin });
    const res = await call('POST', `/api/orgs/${orgId}/sso`, {
      as: admin,
      body: { type: 'oidc', domainId: d.id, providerId: 'sso-acme-dev', issuer: 'https://login.acme.dev', config: { clientId: 'c', clientSecret: 's' } },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ providerId: 'sso-acme-dev', redirectUrl: expect.stringMatching(/\/api\/auth\/sso\/callback\/sso-acme-dev$/) });
    const row = await testEnv.DB.prepare('SELECT createdAt FROM ssoProvider WHERE providerId = ?').bind('sso-acme-dev').first<{ createdAt: number }>();
    expect(row?.createdAt).toBeGreaterThan(0);
  });

  it('refuses providerIds of built-in methods, of other providers, and ones accounts still use', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'acme-two.dev' } }));
    fakes.dns.set(d.txtName, [d.txtValue]);
    await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin });
    const register = (providerId: string) =>
      call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: { type: 'oidc', domainId: d.id, providerId, issuer: 'https://login.acme-two.dev', config: { clientId: 'c', clientSecret: 's' } } });
    for (const reserved of ['google', 'microsoft', 'credential', 'email-otp', 'github', 'acme-okta']) expect((await register(reserved)).status).toBe(400);
    await seedSso(await seedOrg(fakes, await seedUser(fakes), 'Other'), { domain: 'other.com', providerId: 'sso-other' });
    expect((await register('sso-other')).status).toBe(409);
    await insertRow('account', { id: crypto.randomUUID(), userId: admin.id, accountId: 'x', providerId: 'sso-leftover', createdAt: future(), updatedAt: future() });
    expect((await register('sso-leftover')).status).toBe(409);
    expect((await register('sso-fresh')).status).toBe(201);
  });
});

describe('SSO delete (T11, D31)', () => {
  it('needs MFA; without a policy depending on it, deletes at once and ends the SSO sessions', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com` });
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes, { email: `bob-${tag}@acme.com` });
    await addMember(orgId, bob);
    const inst = await seedInstance(orgId, { teams: [await seedTeam(fakes, orgId, 'Eng', [bob])] });
    const sso = await seedSso(orgId, { domain: 'acme.com', admin });
    await insertRow('account', { id: crypto.randomUUID(), userId: bob.id, accountId: 'idp-bob', providerId: sso.providerId, createdAt: future(), updatedAt: future() });
    const ssoSession = await seedSession(bob, { method: 'sso', ssoOrgId: orgId });
    const otpSession = await seedSession(bob, { method: 'email-otp' });

    expect((await call('DELETE', `/api/orgs/${orgId}/sso/${sso.id}`, { as: admin })).status).toBe(403);
    expect((await call('DELETE', `/api/orgs/${orgId}/sso/nope`, { as: admin, mfa: true })).status).toBe(404);
    const res = await call('DELETE', `/api/orgs/${orgId}/sso/${sso.id}`, { as: admin, mfa: true });
    expect(res.status).toBe(200);

    expect(await testEnv.DB.prepare('SELECT 1 FROM ssoProvider WHERE id = ?').bind(sso.id).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT 1 FROM account WHERE providerId = ?').bind(sso.providerId).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT 1 FROM session WHERE id = ?').bind(ssoSession).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT 1 FROM session WHERE id = ?').bind(otpSession).first()).not.toBeNull();
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { cpSessionId: ssoSession }]);
    const audit = await readOrgAudit(testEnv, orgId);
    expect(audit.find((e) => e.action === 'sso.removed')).toMatchObject({ targetId: sso.id, details: { providerId: sso.providerId, domain: 'acme.com', sessionsEnded: 1 } });
  });

  it("removes only this org's members' accounts, and never touches a built-in provider id", async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com` });
    const orgId = await seedOrg(fakes, admin);
    const member = await seedUser(fakes, { email: `m-${tag}@acme.com` });
    await addMember(orgId, member);
    const outsider = await seedUser(fakes, { email: `o-${tag}@else.com` });
    const sso = await seedSso(orgId, { domain: 'acme.com', admin });
    const acct = (u: TestUser, providerId: string) => insertRow('account', { id: crypto.randomUUID(), userId: u.id, accountId: u.id, providerId, createdAt: future(), updatedAt: future() });
    await acct(member, sso.providerId);
    await acct(outsider, sso.providerId);
    expect((await call('DELETE', `/api/orgs/${orgId}/sso/${sso.id}`, { as: admin, mfa: true })).status).toBe(200);
    const left = await testEnv.DB.prepare('SELECT userId FROM account WHERE providerId = ?').bind(sso.providerId).all<{ userId: string }>();
    expect(left.results.map((r) => r.userId)).toEqual([outsider.id]);

    // A provider stored before ids were checked, holding a built-in id.
    const legacy = await seedSso(orgId, { domain: 'acme.com', providerId: 'google', admin });
    await acct(outsider, 'google');
    await acct(member, 'google');
    const res = await call('DELETE', `/api/orgs/${orgId}/sso/${legacy.id}`, { as: admin, mfa: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'provider_id_reserved' });
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM account WHERE providerId = 'google'").first<{ n: number }>())?.n).toBe(2);
    expect(await testEnv.DB.prepare('SELECT 1 FROM ssoProvider WHERE id = ?').bind(legacy.id).first()).not.toBeNull();
  });

  it('needs the emailed confirmation when the policy allows only SSO, and names who is locked out', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann Admin' });
    const orgId = await seedOrg(fakes, admin);
    await seedPasskey(admin);
    const bob = await seedUser(fakes, { email: `bob-${tag}@acme.com`, name: 'Bob' });
    await addMember(orgId, bob);
    const sso = await seedSso(orgId, { domain: 'acme.com', admin });
    await setPolicy(orgId, admin, ['sso', 'passkey']); // bob has SSO, the admin a passkey: nobody locked out
    await setPolicy(orgId, admin, ['sso']); // still nobody: both are on acme.com, which the provider serves

    const del = (body?: unknown) => call('DELETE', `/api/orgs/${orgId}/sso/${sso.id}`, { as: admin, mfa: true, body });
    const refused = await del();
    expect(refused.status).toBe(409);
    const r = await json<{ error: string; affected: Affected[]; policyDependence: string[] }>(refused);
    expect(r.error).toBe('lock_out_confirmation_required');
    expect(r.policyDependence).toContain('org_policy_sso_only');
    expect(r.affected.map((a) => [a.name, a.email, a.reasons])).toEqual([
      ['Ann Admin', `admin-${tag}@acme.com`, ['method']],
      ['Bob', `bob-${tag}@acme.com`, ['method']],
    ]);
    expect((await del({ confirmName: 'wrong' })).status).toBe(422);
    const started = await del({ confirmName: sso.providerId });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ status: 'confirmation_sent', affected: [{ id: admin.id }, { id: bob.id }] });
    expect(fakes.mail.at(-1)?.text).toContain(`Bob <bob-${tag}@acme.com>`);
    expect(await testEnv.DB.prepare('SELECT 1 FROM ssoProvider WHERE id = ?').bind(sso.id).first()).not.toBeNull();

    const { id, token } = lastConfirmLink(fakes);
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } })).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT 1 FROM ssoProvider WHERE id = ?').bind(sso.id).first()).toBeNull();
  });

  it('is destructive while an instance policy requires SSO, even if nobody is affected today', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com` });
    const orgId = await seedOrg(fakes, admin);
    const inst = await seedInstance(orgId);
    const sso = await seedSso(orgId, { domain: 'acme.com', admin });
    expect((await call('PUT', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin, body: { requiredMethods: ['sso'] } })).status).toBe(200);
    const res = await call('DELETE', `/api/orgs/${orgId}/sso/${sso.id}`, { as: admin, mfa: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ affected: [], policyDependence: ['instance_policy_requires_sso'] });
  });
});

describe('lock-out check on policy changes (D31)', () => {
  it('removing a method someone is signed in with is destructive and names them', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann' });
    const orgId = await seedOrg(fakes, admin);
    const carol = await seedUser(fakes, { email: `carol-${tag}@acme.com`, name: 'Carol' });
    await addMember(orgId, carol);
    await seedSession(carol, { method: 'email-otp', createdAt: Date.now() - 60_000 });
    await seedSession(carol, { method: 'google' }); // the newest one counts
    await setPolicy(orgId, admin, ['email-otp', 'passkey', 'google']);

    const res = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { allowedMethods: ['email-otp', 'passkey'], requiredDomain: null } });
    expect(res.status).toBe(409);
    const { affected } = await json<{ affected: Affected[] }>(res);
    expect(affected).toEqual([{ id: carol.id, name: 'Carol', email: `carol-${tag}@acme.com`, reasons: ['signed_out'], instanceIds: [] }]);

    // Adding methods never locks anybody out.
    await setPolicy(orgId, admin, ['email-otp', 'passkey', 'google', 'microsoft']);
  });

  it('dropping email codes locks out members without a passkey, not those with one', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann' });
    const orgId = await seedOrg(fakes, admin);
    await seedPasskey(admin);
    const dave = await seedUser(fakes, { email: `dave-${tag}@acme.com`, name: 'Dave' });
    await addMember(orgId, dave);
    const res = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { allowedMethods: ['passkey'], requiredDomain: null } });
    expect(res.status).toBe(409);
    expect((await json<{ affected: Affected[] }>(res)).affected.map((a) => [a.id, a.reasons])).toEqual([[dave.id, ['method']]]);

    await seedPasskey(dave);
    await setPolicy(orgId, admin, ['passkey']);
  });

  it('SSO only: members on the provider domain keep a way in, the others are named', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann' });
    const orgId = await seedOrg(fakes, admin);
    await seedSso(orgId, { domain: 'acme.com', admin });
    const eve = await seedUser(fakes, { email: `eve-${tag}@contractor.io`, name: 'Eve' });
    await addMember(orgId, eve);
    const res = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { allowedMethods: ['sso'], requiredDomain: null } });
    expect(res.status).toBe(409);
    expect((await json<{ affected: Affected[] }>(res)).affected).toEqual([{ id: eve.id, name: 'Eve', email: `eve-${tag}@contractor.io`, reasons: ['method'], instanceIds: [] }]);
  });

  it('a required domain names the members elsewhere, with their instances; confirmed, it applies', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann' });
    const orgId = await seedOrg(fakes, admin);
    const frank = await seedUser(fakes, { email: `frank-${tag}@gmail.com`, name: 'Frank' });
    await addMember(orgId, frank);
    const inst = await seedInstance(orgId, { teams: [await seedTeam(fakes, orgId, 'Eng', [frank])] });

    const body = { allowedMethods: [], requiredDomain: 'acme.com' };
    const res = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body });
    expect(res.status).toBe(409);
    expect((await json<{ affected: Affected[] }>(res)).affected).toEqual([{ id: frank.id, name: 'Frank', email: `frank-${tag}@gmail.com`, reasons: ['domain'], instanceIds: [inst] }]);
    expect((await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, body: { ...body, confirmName: 'Acme' } })).status).toBe(403);
    const started = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { ...body, confirmName: 'Acme' } });
    expect(started.status).toBe(202);
    expect(fakes.mail.at(-1)?.text).toContain(`Frank <frank-${tag}@gmail.com>`);
    const { id, token } = lastConfirmLink(fakes);
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } })).status).toBe(200);
    expect(await json(await call('GET', `/api/orgs/${orgId}/policy`, { as: admin }))).toEqual({ allowedMethods: [], requiredDomain: 'acme.com', instanceOverrides: [] });
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { all: true }]);

    // Already outside the domain: a later unrelated change doesn't count them again.
    await setPolicy(orgId, admin, ['email-otp', 'passkey'], 'acme.com');
  });

  it('an instance policy that locks out the people of its teams needs the confirmation', async () => {
    const admin = await seedUser(fakes, { email: `admin-${tag}@acme.com`, name: 'Ann' });
    const orgId = await seedOrg(fakes, admin);
    const gina = await seedUser(fakes, { email: `gina-${tag}@acme.com`, name: 'Gina' });
    await addMember(orgId, gina);
    const team = await seedTeam(fakes, orgId, 'Eng', [gina]);
    const inst = await seedInstance(orgId, { teams: [team] });
    const put = (b: unknown, mfa = true) => call('PUT', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin, mfa, body: b });

    const res = await put({ requiredMethods: ['passkey'] });
    expect(res.status).toBe(409);
    expect((await json<{ affected: Affected[] }>(res)).affected).toEqual([{ id: gina.id, name: 'Gina', email: `gina-${tag}@acme.com`, reasons: ['method'], instanceIds: [inst] }]);
    expect((await put({ requiredMethods: ['passkey'], confirmName: 'wrong' })).status).toBe(422);
    expect((await put({ requiredMethods: ['passkey'], confirmName: 'enc' }, false)).status).toBe(403);
    expect((await put({ requiredMethods: ['passkey'], confirmName: 'enc' })).status).toBe(202); // the instance's display name
    expect(await json(await call('GET', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin }))).toMatchObject({ requiredMethods: [] });
    const { id, token } = lastConfirmLink(fakes);
    expect((await call('POST', `/confirm/${id}`, { as: admin, mfa: true, form: { t: token } })).status).toBe(200);
    expect(await json(await call('GET', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin }))).toMatchObject({ requiredMethods: ['passkey'] });
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { all: true }]);

    // With a passkey, Gina keeps her way in: no confirmation for a further change.
    await seedPasskey(gina);
    expect((await put({ requiredMethods: ['passkey'] })).status).toBe(200);
  });
});

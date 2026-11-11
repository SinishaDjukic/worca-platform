import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ssoRegistrationBody } from '../../../packages/platform/src/control/tenancy/deps';
import {
  addMember,
  ensureTables,
  type Fakes,
  gateCalls,
  harness,
  installFakes,
  resetGate,
  seedInstance,
  seedOrg,
  seedTeam,
  seedUser,
  testEnv,
} from './helpers/tenancy-fixtures';

let fakes: Fakes;
const call = harness();

beforeAll(ensureTables);
beforeEach(async () => {
  fakes = installFakes();
  await resetGate();
});

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe('orgs', () => {
  it('an active user creates an org and becomes its tenant admin; pending users cannot', async () => {
    const pending = await seedUser(fakes, { status: 'pending' });
    expect((await call('POST', '/api/orgs', { as: pending, body: { name: 'Nope' } })).status).toBe(403);

    // D25: someone who only joined through an invitation can't open their own org before
    // registration is open (Better Auth's own check doesn't run for server-side calls).
    const invitee = await seedUser(fakes, { registeredVia: 'invitation' });
    const refused = await call('POST', '/api/orgs', { as: invitee, body: { name: 'Mine' } });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toEqual({ error: 'org_creation_not_allowed' });

    const alice = await seedUser(fakes);
    const res = await call('POST', '/api/orgs', { as: alice, body: { name: 'Acme' } });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    expect(fakes.ring.ensured.has(`org:${id}`)).toBe(true);
    const org = await json<{ name: string; role: string; tier: { id: string; members: number } }>(await call('GET', `/api/orgs/${id}`, { as: alice }));
    expect(org).toMatchObject({ name: 'Acme', role: 'tenant_admin', tier: { id: 'free', members: 10 } });

    expect((await call('PATCH', `/api/orgs/${id}`, { as: alice, body: { name: 'Acme 2' } })).status).toBe(200);
    expect((await json<{ name: string }>(await call('GET', `/api/orgs/${id}`, { as: alice }))).name).toBe('Acme 2');
    const audit = await json<{ entries: { action: string; details: unknown }[] }>(await call('GET', `/api/orgs/${id}/audit`, { as: alice }));
    expect(audit.entries.map((e) => e.action)).toEqual(['org.renamed', 'org.created']);
    expect(audit.entries[0]?.details).toEqual({ name: 'Acme 2' });
    // Details are stored encrypted (D41).
    const raw = await testEnv.DB.prepare('SELECT details FROM audit_org WHERE org_id = ?').bind(id).all<{ details: string }>();
    expect(raw.results.every((r) => r.details.startsWith('enc:v1:'))).toBe(true);
  });
});

describe('members', () => {
  it('last tenant admin can be neither demoted nor removed (D18); removal drops gate sessions (D46)', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes);
    await addMember(orgId, bob);
    const team = await seedTeam(fakes, orgId, 'Eng', [bob]);
    const inst = await seedInstance(orgId, { teams: [team] });

    expect((await call('PATCH', `/api/orgs/${orgId}/members/${admin.id}`, { as: admin, body: { role: 'tenant_user' } })).status).toBe(409);
    expect((await call('DELETE', `/api/orgs/${orgId}/members/${admin.id}`, { as: admin })).status).toBe(409);
    // A tenant user can't remove others but may leave.
    expect((await call('DELETE', `/api/orgs/${orgId}/members/${admin.id}`, { as: bob })).status).toBe(403);

    const members = await json<{ members: { userId: string; email: string }[] }>(await call('GET', `/api/orgs/${orgId}/members`, { as: bob }));
    expect(members.members.map((m) => m.email).sort()).toEqual([admin.email, bob.email].sort());

    expect((await call('PATCH', `/api/orgs/${orgId}/members/${bob.id}`, { as: admin, body: { role: 'tenant_admin' } })).status).toBe(200);
    expect((await call('PATCH', `/api/orgs/${orgId}/members/${admin.id}`, { as: bob, body: { role: 'tenant_user' } })).status).toBe(200);
    expect((await call('DELETE', `/api/orgs/${orgId}/members/${bob.id}`, { as: bob })).status).toBe(409); // now the last admin
    expect((await call('PATCH', `/api/orgs/${orgId}/members/${admin.id}`, { as: bob, body: { role: 'tenant_admin' } })).status).toBe(200);
    expect((await call('DELETE', `/api/orgs/${orgId}/members/${bob.id}`, { as: admin })).status).toBe(200);

    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { userId: bob.id }]);
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM teamMember WHERE userId = ?').bind(bob.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('invitations respect the tier member limit (D33) and can be listed and canceled', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const res = await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'new@example.com' } });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const list = await json<{ invitations: { id: string; email: string; role: string }[] }>(await call('GET', `/api/orgs/${orgId}/invitations`, { as: admin }));
    expect(list.invitations).toMatchObject([{ id, email: 'new@example.com', role: 'tenant_user' }]);
    expect((await call('DELETE', `/api/orgs/${orgId}/invitations/${id}`, { as: admin })).status).toBe(200);
    expect((await call('DELETE', `/api/orgs/${orgId}/invitations/${id}`, { as: admin })).status).toBe(404);

    // 1 member + 9 pending = 10: the next invitation is refused.
    for (let i = 0; i < 9; i++) await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: `p${i}@example.com` } });
    expect((await call('POST', `/api/orgs/${orgId}/invitations`, { as: admin, body: { email: 'over@example.com' } })).status).toBe(409);
  });
});

describe('teams', () => {
  it('CRUD with encrypted names; removing members or the team drops their sessions', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const bob = await seedUser(fakes);
    await addMember(orgId, bob);
    const outsider = await seedUser(fakes);

    const { id: teamId } = await json<{ id: string }>(await call('POST', `/api/orgs/${orgId}/teams`, { as: admin, body: { name: 'Platform' } }));
    const stored = await testEnv.DB.prepare('SELECT name FROM team WHERE id = ?').bind(teamId).first<{ name: string }>();
    expect(stored?.name.startsWith('enc:v1:')).toBe(true); // D39
    const inst = await seedInstance(orgId, { teams: [teamId] });

    expect((await call('POST', `/api/orgs/${orgId}/teams/${teamId}/members`, { as: admin, body: { userId: outsider.id } })).status).toBe(404);
    expect((await call('POST', `/api/orgs/${orgId}/teams/${teamId}/members`, { as: admin, body: { userId: bob.id } })).status).toBe(201);
    expect((await call('POST', `/api/orgs/${orgId}/teams/${teamId}/members`, { as: admin, body: { userId: bob.id } })).status).toBe(409);
    expect((await call('PATCH', `/api/orgs/${orgId}/teams/${teamId}`, { as: admin, body: { name: 'Core' } })).status).toBe(200);

    const teams = await json<{ teams: { id: string; name: string; members: number; instanceIds: string[] }[] }>(await call('GET', `/api/orgs/${orgId}/teams`, { as: admin }));
    expect(teams.teams).toEqual([{ id: teamId, name: 'Core', members: 1, mine: false, instanceIds: [inst], createdAt: expect.any(String) }]);
    // Tenant users see the directory: names, counts and membership, no grants (tenancy-members.test.ts).
    expect((await json<{ teams: unknown[] }>(await call('GET', `/api/orgs/${orgId}/teams`, { as: bob }))).teams).toEqual([{ id: teamId, name: 'Core', members: 1, mine: true }]);

    expect((await call('DELETE', `/api/orgs/${orgId}/teams/${teamId}/members/${bob.id}`, { as: admin })).status).toBe(200);
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { userId: bob.id }]);
    await resetGate();

    await call('POST', `/api/orgs/${orgId}/teams/${teamId}/members`, { as: admin, body: { userId: bob.id } });
    // D71: the team is the instance's only one, so it stays until the instance has another.
    const refused = await call('DELETE', `/api/orgs/${orgId}/teams/${teamId}`, { as: admin });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'team_has_instances', instances: 1 });
    expect(await gateCalls()).toEqual([]);
    const other = await seedTeam(fakes, orgId, 'Other');
    await testEnv.DB.prepare('INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)').bind(inst, other).run();
    expect((await call('DELETE', `/api/orgs/${orgId}/teams/${teamId}`, { as: admin })).status).toBe(200);
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { userId: bob.id }]);
    const links = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM instance_teams WHERE team_id = ?').bind(teamId).first<{ n: number }>();
    expect(links?.n).toBe(0);
    const kept = await testEnv.DB.prepare('SELECT team_id FROM instance_teams WHERE instance_id = ?').bind(inst).all<{ team_id: string }>();
    expect(kept.results).toEqual([{ team_id: other }]);
  });

  it('a team that is only the team of instances being deleted can go (D71)', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const team = await seedTeam(fakes, orgId, 'Eng');
    await seedInstance(orgId, { status: 'deleting', teams: [team] });
    expect((await call('DELETE', `/api/orgs/${orgId}/teams/${team}`, { as: admin })).status).toBe(200);
  });

  it("can't touch another org's team", async () => {
    const a = await seedUser(fakes);
    const orgA = await seedOrg(fakes, a);
    const b = await seedUser(fakes);
    const orgB = await seedOrg(fakes, b);
    const teamB = await seedTeam(fakes, orgB, 'B');
    expect((await call('PATCH', `/api/orgs/${orgA}/teams/${teamB}`, { as: a, body: { name: 'x' } })).status).toBe(404);
    expect((await call('DELETE', `/api/orgs/${orgA}/teams/${teamB}`, { as: a })).status).toBe(404);
  });
});

describe('login policy', () => {
  it('non-locking changes apply at once; lock-out changes need confirmName + MFA and an emailed link (D31)', async () => {
    const admin = await seedUser(fakes, { email: 'admin@acme.com' });
    const orgId = await seedOrg(fakes, admin, 'Acme');
    const inst = await seedInstance(orgId);

    const ok = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, body: { allowedMethods: ['email-otp', 'passkey'], requiredDomain: 'acme.com' } });
    expect(ok.status).toBe(200);
    expect(await json(await call('GET', `/api/orgs/${orgId}/policy`, { as: admin }))).toEqual({ allowedMethods: ['email-otp', 'passkey'], requiredDomain: 'acme.com', instanceOverrides: [] });
    expect(await gateCalls()).toContainEqual(['dropSessions', inst, { all: true }]);

    const outsider = await seedUser(fakes, { email: 'contractor@other.org' });
    await addMember(orgId, outsider);
    const body = { allowedMethods: ['sso'], requiredDomain: 'acme.com' };
    expect((await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body })).status).toBe(409); // names the affected first
    expect((await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { ...body, confirmName: 'acme' } })).status).toBe(422);
    expect((await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, body: { ...body, confirmName: 'Acme' } })).status).toBe(403);
    const started = await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, mfa: true, body: { ...body, confirmName: 'Acme' } });
    expect(started.status).toBe(202);
    expect(fakes.mail.at(-1)?.text).toContain('1 member(s) would no longer be able to sign in'); // the admin (no SSO); the outsider already failed the domain
    // Not applied yet.
    expect((await json<{ allowedMethods: string[] }>(await call('GET', `/api/orgs/${orgId}/policy`, { as: admin }))).allowedMethods).toEqual(['email-otp', 'passkey']);
  });

  it('instance policy can only narrow the org policy (D23)', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const inst = await seedInstance(orgId);
    const other = await seedInstance((await seedOrg(fakes, await seedUser(fakes))));
    await call('PUT', `/api/orgs/${orgId}/policy`, { as: admin, body: { allowedMethods: ['email-otp', 'passkey'], requiredDomain: null } });

    expect((await call('PUT', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin, body: { requiredMethods: ['sso'] } })).status).toBe(400);
    expect((await call('PUT', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin, body: { requiredMethods: ['passkey'] } })).status).toBe(200);
    expect(await json(await call('GET', `/api/orgs/${orgId}/instances/${inst}/policy`, { as: admin }))).toEqual({ requiredMethods: ['passkey'], orgAllowedMethods: ['email-otp', 'passkey'] });
    expect((await json<{ instanceOverrides: unknown }>(await call('GET', `/api/orgs/${orgId}/policy`, { as: admin }))).instanceOverrides).toEqual([
      { instanceId: inst, requiredMethods: ['passkey'] },
    ]);
    expect((await call('GET', `/api/orgs/${orgId}/instances/${other}/policy`, { as: admin })).status).toBe(404);
  });
});

describe('domains and SSO', () => {
  it('verifies a domain through the TXT record and only then registers SSO', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const res = await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'Acme.COM' } });
    expect(res.status).toBe(201);
    const d = await json<{ id: string; domain: string; txtName: string; txtValue: string }>(res);
    expect(d).toMatchObject({ domain: 'acme.com', txtName: '_worca-verification.acme.com' });
    expect((await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'acme.com' } })).status).toBe(409);

    const oidc = { type: 'oidc', domainId: d.id, issuer: 'https://login.acme.com', config: { clientId: 'c', clientSecret: 's' } };
    expect((await call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: oidc })).status).toBe(409);
    expect((await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin })).status).toBe(422);

    fakes.dns.set(d.txtName, ['unrelated', d.txtValue]);
    expect(await json(await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin }))).toMatchObject({ verified: true });
    expect((await call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: oidc })).status).toBe(201);

    // Another org can't verify the same domain.
    const b = await seedUser(fakes);
    const orgB = await seedOrg(fakes, b);
    const dB = await json<{ id: string }>(await call('POST', `/api/orgs/${orgB}/domains`, { as: b, body: { domain: 'acme.com' } }));
    expect((await call('POST', `/api/orgs/${orgB}/domains/${dB.id}/verify`, { as: b })).status).toBe(409);
  });

  it('refuses SSO configs that try to set trusted fields', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'acme.io' } }));
    fakes.dns.set(d.txtName, [d.txtValue]);
    await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin });
    const evil = { type: 'oidc', domainId: d.id, issuer: 'https://login.acme.io', config: { clientId: 'c', clientSecret: 's', organizationId: 'other-org', domain: 'victim.com' } };
    expect((await call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: evil })).status).toBe(400);
    expect((await call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: { ...evil, config: { clientId: 'c', clientSecret: 's' }, organizationId: 'x' } })).status).toBe(400);

    // And the body builder puts the trusted values last whatever the config holds. It never
    // names an org: the provider is moved to the org after registration (deps.ts).
    const body = ssoRegistrationBody({
      providerId: 'p1',
      domain: 'acme.io',
      issuer: 'https://login.acme.io',
      config: { oidcConfig: { clientId: 'c' }, providerId: 'evil', issuer: 'https://evil', domain: 'victim.com', organizationId: 'other' },
    });
    expect(body).toEqual({ oidcConfig: { clientId: 'c' }, providerId: 'p1', issuer: 'https://login.acme.io', domain: 'acme.io' });
  });
});

describe('org key rotation (D38)', () => {
  it('needs a tenant admin with MFA', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    expect((await call('POST', `/api/orgs/${orgId}/keys/rotate`, { as: admin })).status).toBe(403);
    expect(await json(await call('POST', `/api/orgs/${orgId}/keys/rotate`, { as: admin, mfa: true }))).toEqual({ version: 2 });
  });

  it('refuses while re-encryption runs (409) and more than once an hour (429)', async () => {
    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const rotate = () => call('POST', `/api/orgs/${orgId}/keys/rotate`, { as: admin, mfa: true });
    const hourAgo = Date.now() - 61 * 60_000;
    // The fake key ring writes nothing, so the state a real rotation leaves is seeded here.
    await testEnv.DB.prepare(
      `INSERT INTO key_rotation_jobs (org_id, target_version, status, started_at, updated_at) VALUES (?, 2, 'running', ?, ?)`,
    )
      .bind(orgId, hourAgo, hourAgo)
      .run();
    expect(await json(await rotate())).toEqual({ error: 'rotation_in_progress' });
    await testEnv.DB.prepare("UPDATE key_rotation_jobs SET status = 'verifying' WHERE org_id = ?").bind(orgId).run();
    expect((await rotate()).status).toBe(409);
    await testEnv.DB.prepare("UPDATE key_rotation_jobs SET status = 'done' WHERE org_id = ?").bind(orgId).run();
    // A version created by a rotation 10 minutes ago: too soon.
    await testEnv.DB.prepare('INSERT INTO data_keys (id, owner_type, owner_id, version, wrapped, created_at, rotated_at) VALUES (?, ?, ?, 3, ?, ?, ?)')
      .bind(crypto.randomUUID(), 'org', orgId, 'm1.a.b', Date.now(), Date.now() - 10 * 60_000)
      .run();
    const soon = await rotate();
    expect(soon.status).toBe(429);
    expect(await json(soon)).toEqual({ error: 'rotation_too_soon' });
    // Over an hour since both the job and the version: allowed; incomplete jobs don't block.
    await testEnv.DB.prepare('UPDATE data_keys SET rotated_at = ? WHERE owner_id = ?').bind(hourAgo, orgId).run();
    await testEnv.DB.prepare("UPDATE key_rotation_jobs SET status = 'incomplete' WHERE org_id = ?").bind(orgId).run();
    expect((await rotate()).status).toBe(200);
  });
});

describe('SSRF guard on IdP URLs', () => {
  const rejected = [
    'http://login.acme.com', // not https
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://localhost/x',
    'https://idp.localhost/x',
    'https://metadata.internal/x',
    'https://user:pw@login.acme.com/x',
  ];
  it.each(rejected)('rejects %s', async (url) => {
    const { isSafeUrl } = await import('../../../packages/platform/src/control/tenancy/safe-url');
    expect(isSafeUrl(url)).toBe(false);
  });

  it('accepts a public https host, rejects our own domains and endpoints off the issuer', async () => {
    const { isSafeUrl, isForeignHost } = await import('../../../packages/platform/src/control/tenancy/safe-url');
    expect(isSafeUrl('https://login.acme.com/.well-known/openid-configuration')).toBe(true);
    for (const h of [testEnv.INSTANCE_DOMAIN, `abc.${testEnv.INSTANCE_DOMAIN}`, new URL(testEnv.APP_ORIGIN).hostname]) {
      expect(isForeignHost(testEnv, h)).toBe(false);
    }
    // Ours means this deployment's domains, whatever they are.
    const hosted = { APP_ORIGIN: 'https://app.example.com', INSTANCE_DOMAIN: 'example.net' };
    for (const h of ['example.net', 'abc.example.net', 'ABC.example.net.', 'app.example.com']) expect(isForeignHost(hosted, h)).toBe(false);
    expect(isForeignHost(hosted, 'example.com')).toBe(true);

    const admin = await seedUser(fakes);
    const orgId = await seedOrg(fakes, admin);
    const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain: 'acme.dev' } }));
    fakes.dns.set(d.txtName, [d.txtValue]);
    await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin });
    const base = { type: 'oidc', domainId: d.id, issuer: 'https://login.acme.dev', config: { clientId: 'c', clientSecret: 's' } };
    const sso = (b: unknown) => call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: b });
    expect((await sso({ ...base, issuer: 'https://169.254.169.254' })).status).toBe(400);
    expect((await sso({ ...base, issuer: `https://x.${testEnv.INSTANCE_DOMAIN}` })).status).toBe(400);
    expect((await sso({ ...base, config: { ...base.config, tokenEndpoint: 'https://localhost/token' } })).status).toBe(400);
    expect((await sso({ ...base, config: { ...base.config, jwksEndpoint: 'https://attacker.example/jwks' } })).status).toBe(400);
    expect((await sso({ type: 'saml', domainId: d.id, issuer: 'https://login.acme.dev', config: { entryPoint: 'https://10.0.0.1/sso', cert: 'x' } })).status).toBe(400);
    expect((await sso({ ...base, config: { ...base.config, tokenEndpoint: 'https://auth.acme.dev/token' } })).status).toBe(201);
  });
});

describe('domain deletion and ownership', () => {
  it('refuses deleting a domain an SSO provider or the login policy depends on', async () => {
    const admin = await seedUser(fakes, { email: 'a@acme.net' });
    const orgId = await seedOrg(fakes, admin, 'Acme');
    const mk = async (domain: string) => {
      const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgId}/domains`, { as: admin, body: { domain } }));
      fakes.dns.set(d.txtName, [d.txtValue]);
      await call('POST', `/api/orgs/${orgId}/domains/${d.id}/verify`, { as: admin });
      return d.id;
    };
    const ssoDomain = await mk('acme.net');
    await call('POST', `/api/orgs/${orgId}/sso`, { as: admin, body: { type: 'oidc', domainId: ssoDomain, issuer: 'https://login.acme.net', config: { clientId: 'c', clientSecret: 's' } } });
    expect((await call('DELETE', `/api/orgs/${orgId}/domains/${ssoDomain}`, { as: admin })).status).toBe(409);

    const policyDomain = await mk('acme.org');
    // Seeded directly: through the API this policy would need the emailed confirmation.
    await testEnv.DB.prepare('INSERT INTO org_login_policies (org_id, allowed_methods, required_domain, required_domain_index, updated_at) VALUES (?, ?, NULL, (SELECT domain_index FROM org_domains WHERE id = ?), ?)')
      .bind(orgId, '[]', policyDomain, Date.now())
      .run();
    expect((await call('DELETE', `/api/orgs/${orgId}/domains/${policyDomain}`, { as: admin })).status).toBe(409);

    const free = await mk('acme.info');
    expect((await call('DELETE', `/api/orgs/${orgId}/domains/${free}`, { as: admin })).status).toBe(200);
  });

  it("can't verify a domain another org's SSO provider holds verified", async () => {
    const a = await seedUser(fakes);
    const orgA = await seedOrg(fakes, a);
    await testEnv.DB.prepare('INSERT INTO ssoProvider (id, issuer, userId, providerId, organizationId, domain, domainIndex, domainVerified) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
      .bind(crypto.randomUUID(), 'https://idp.held.com', a.id, `p-${crypto.randomUUID().slice(0, 8)}`, orgA, 'enc', await fakes.ring.blindIndex('held.com'))
      .run();
    const b = await seedUser(fakes);
    const orgB = await seedOrg(fakes, b);
    const d = await json<{ id: string; txtName: string; txtValue: string }>(await call('POST', `/api/orgs/${orgB}/domains`, { as: b, body: { domain: 'held.com' } }));
    fakes.dns.set(d.txtName, [d.txtValue]);
    expect((await call('POST', `/api/orgs/${orgB}/domains/${d.id}/verify`, { as: b })).status).toBe(409);
  });
});

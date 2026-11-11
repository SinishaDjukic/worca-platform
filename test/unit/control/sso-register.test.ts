// Registering org SSO connectors through the real Better Auth SSO plugin, and signing in with
// one (D22). The IdP is faked by intercepting fetch: the worker under SELF shares this isolate.
import { env, SELF } from 'cloudflare:test';
import { APIError } from 'better-call';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAuth } from '../../../packages/platform/src/control/auth/index';
import { clientError } from '../../../packages/platform/src/control/index';
import { DiscoveryError } from '@better-auth/sso';
import { idpUrlAllowed, ssoRegistrationFailure } from '../../../packages/platform/src/control/tenancy/sso-routes';
import type { Env } from '../../../packages/platform/src/control/env';

const ORIGIN = env.APP_ORIGIN;
let seq = 0;

/** A self-signed test certificate (public half only). */
const IDP_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUZ1X+4Jm/adv1dE8DCDg+k1yBGVUwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQdGVzdC1pZHAuZXhhbXBsZTAeFw0yNjEwMDYxNzA5MTha
Fw0zNjEwMDMxNzA5MThaMBsxGTAXBgNVBAMMEHRlc3QtaWRwLmV4YW1wbGUwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCtoT34VzfgCI/BWxJariE14Bfx
7a26rBHQgH5SLylbDJrzwn+ylj/4G4ZzXuM/HScuEoGUOvLrZiIkUY6hMJLPvmwK
4bWr/fDIxWQnmoJB/KF1SHwXLkDAksqy6sMO7OBNdTAjl8JQys1lRBJzaL5O8ghX
2iuthFa24VwsnEDL6NU64dG67gMQb2nJrnvGjkcYqw4Hk1RCoYglt+i5tVASYnSD
StP7L8KlIzNjgA40JuEamR938D3OZ5yWR+Ap8DZTIb9bZxtHGWldhuqitn1zyoMe
2J2JUMfm05Es0Xzg4+K4uO9CZ1fPKqO2rRdcmhX5jlpZmoOLttwot9gkF3dLAgMB
AAGjUzBRMB0GA1UdDgQWBBRPCAq+GLsfGxCW6ApJzCnPt5PsyjAfBgNVHSMEGDAW
gBRPCAq+GLsfGxCW6ApJzCnPt5PsyjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQBBCcHA9Qf56uVnpE/CF59Kr5KT3T96IDoBLjC4Jk2oVcQMDK+l
LTklgyIPa58iP31PhF1ScE2WtkkjpRA/rUQxXcs2K8CLj9XykwQVuncHElh6P67K
4Ry3dzxRum27N5ddhqXO95SOK0+09tDqIqUpjdCk6dVM4XAV1nutyYeq/g1DlAhw
xm9fyTZdrdxVWk2rFVNrIng+mtT769Hs+0gg/7YZG4CCvwW0x+p77Jkk1mkTPUye
QnBlv2g1m5SOSPp1EboS/seieqHYoE7zlUJ9vgSrfic8B4A5Mdg32hVzKaimGaaT
YajX+ycbU/XdooJjs0uF9ydfUgxahw7fIe/U
-----END CERTIFICATE-----`;

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

async function signIn(email: string): Promise<string> {
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'open', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  expect((await req('POST', '/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
  const otp = /code: (\d{6})/.exec(mails.at(-1)!.subject)![1]!;
  const res = await req('POST', '/api/auth/sign-in/email-otp', { email, otp });
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

/** A tenant admin with an org and a verified domain (DNS verification is tenancy's own, tested elsewhere). */
async function tenant() {
  const domain = `acme-${Date.now()}-${++seq}.com`;
  const cookie = await signIn(`admin@${domain}`);
  const org = await req('POST', '/api/orgs', { name: 'Acme' }, cookie);
  expect(org.status).toBe(201);
  const { id: orgId } = (await org.json()) as { id: string };
  const d = (await (await req('POST', `/api/orgs/${orgId}/domains`, { domain }, cookie)).json()) as { id: string };
  await env.DB.prepare('UPDATE org_domains SET verified_at = ? WHERE id = ?').bind(Date.now(), d.id).run();
  const register = (body: Record<string, unknown>) => req('POST', `/api/orgs/${orgId}/sso`, { domainId: d.id, ...body }, cookie);
  return { domain, orgId, cookie, domainId: d.id, register };
}

// ---- a fake IdP behind fetch --------------------------------------------------------------------

type Handler = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
let idpRoutes: Handler[] = [];
const fetched: string[] = [];

function idp(issuer: string, doc: Record<string, unknown> = {}) {
  const u = new URL(issuer);
  idpRoutes.push((url) =>
    url.origin === u.origin && url.pathname === `${u.pathname.replace(/\/$/, '')}/.well-known/openid-configuration`
      ? Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          ...doc,
        })
      : undefined,
  );
}

beforeAll(() => {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.origin !== new URL(ORIGIN).origin) {
      fetched.push(href);
      for (const h of idpRoutes) {
        const res = await h(url, init);
        if (res) return res;
      }
      return new Response('not found', { status: 404 });
    }
    return real(input, init);
  });
});
afterEach(() => {
  idpRoutes = [];
  fetched.length = 0;
});

/** The stored provider, decrypted through Better Auth's (wrapped) adapter. */
async function storedProvider(providerId: string) {
  const ctx = await getAuth(env as unknown as Env).$context;
  const row = await ctx.adapter.findOne<Record<string, unknown>>({ model: 'ssoProvider', where: [{ field: 'providerId', value: providerId }] });
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
  return row && { ...row, oidcConfig: parse(row.oidcConfig), samlConfig: parse(row.samlConfig) };
}

const errorOf = async (res: Response) => ({ status: res.status, ...((await res.json()) as { error: string; reason?: string; detail?: string }) });

// ---- OIDC ----------------------------------------------------------------------------------------

describe('OIDC registration', () => {
  it('discovers the endpoints from the issuer and stores them under the org', async () => {
    const t = await tenant();
    const issuer = `https://login.idp-${seq}.example`;
    // Endpoints on other sites than the issuer (as Google and Entra ID have) are fine when discovered.
    idp(issuer, { userinfo_endpoint: 'https://graph.idp-userinfo.example/oidc/userinfo' });
    const res = await t.register({ type: 'oidc', providerId: `sso-disc-${seq}`, issuer, config: { clientId: 'cid', clientSecret: 'shh' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ providerId: `sso-disc-${seq}`, redirectUrl: `${ORIGIN}/api/auth/sso/callback/sso-disc-${seq}` });
    expect(fetched).toEqual([`${issuer}/.well-known/openid-configuration`]);

    const p = await storedProvider(`sso-disc-${seq}`);
    expect(p).toMatchObject({ organizationId: t.orgId, issuer, domain: t.domain, domainVerified: true });
    expect(p!.oidcConfig).toMatchObject({
      clientId: 'cid',
      clientSecret: 'shh',
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksEndpoint: `${issuer}/jwks`,
      userInfoEndpoint: 'https://graph.idp-userinfo.example/oidc/userinfo',
      tokenEndpointAuthentication: 'client_secret_post',
      scopes: ['openid', 'email', 'profile'],
      pkce: true,
    });
    // Encrypted under the org's key, not the registering admin's.
    const raw = await env.DB.prepare('SELECT oidcConfig, domain FROM ssoProvider WHERE providerId = ?').bind(`sso-disc-${seq}`).first<{ oidcConfig: string; domain: string }>();
    expect(raw!.oidcConfig).not.toContain('shh');
    const list = (await (await req('GET', `/api/orgs/${t.orgId}/sso`, undefined, t.cookie)).json()) as { providers: { providerId: string; status: string; domain: string }[] };
    expect(list.providers).toEqual([expect.objectContaining({ providerId: `sso-disc-${seq}`, status: 'active', domain: t.domain })]);
  });

  it('uses a given discovery endpoint, and endpoints given by hand win over discovered ones', async () => {
    const t = await tenant();
    const issuer = `https://idp-${seq}.example/tenant/v2.0`;
    idp(issuer);
    const res = await t.register({
      type: 'oidc',
      providerId: `sso-given-${seq}`,
      issuer,
      config: { clientId: 'c', clientSecret: 's', discoveryEndpoint: `${issuer}/.well-known/openid-configuration`, tokenEndpoint: `https://token.idp-${seq}.example/t`, scopes: ['openid', 'email'], pkce: false },
    });
    expect(res.status).toBe(201);
    expect((await storedProvider(`sso-given-${seq}`))!.oidcConfig).toMatchObject({
      tokenEndpoint: `https://token.idp-${seq}.example/t`,
      authorizationEndpoint: `${issuer}/authorize`,
      scopes: ['openid', 'email'],
      pkce: false,
    });
  });

  it('with skipDiscovery takes the endpoints as given and fetches nothing', async () => {
    const t = await tenant();
    const issuer = `https://auth.idp-${seq}.example`;
    const config = { clientId: 'c', clientSecret: 's', skipDiscovery: true, authorizationEndpoint: `${issuer}/a`, tokenEndpoint: `${issuer}/t`, jwksEndpoint: `${issuer}/k` };
    const missing = await t.register({ type: 'oidc', issuer, config: { ...config, jwksEndpoint: undefined } });
    expect(await errorOf(missing)).toMatchObject({ status: 400, error: 'endpoints_required' });
    const res = await t.register({ type: 'oidc', providerId: `sso-manual-${seq}`, issuer, config });
    expect(res.status).toBe(201);
    expect(fetched).toEqual([]);
    expect((await storedProvider(`sso-manual-${seq}`))!.oidcConfig).toMatchObject({
      authorizationEndpoint: `${issuer}/a`,
      tokenEndpoint: `${issuer}/t`,
      jwksEndpoint: `${issuer}/k`,
      tokenEndpointAuthentication: 'client_secret_basic',
    });
  });

  it('refuses http, private and our own URLs, and endpoints given by hand off the issuer', async () => {
    const t = await tenant();
    const base = { type: 'oidc', config: { clientId: 'c', clientSecret: 's' } };
    for (const issuer of ['http://login.idp.example', 'https://10.0.0.1', 'https://idp.internal', `https://x.${env.INSTANCE_DOMAIN}`, `${ORIGIN}`, 'https://user:pw@login.idp.example']) {
      expect(await errorOf(await t.register({ ...base, issuer }))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
    }
    const issuer = 'https://login.idp.example';
    expect(await errorOf(await t.register({ ...base, issuer, config: { ...base.config, tokenEndpoint: 'http://login.idp.example/t' } }))).toMatchObject({ error: 'idp_url_not_allowed' });
    expect(await errorOf(await t.register({ ...base, issuer, config: { ...base.config, jwksEndpoint: 'https://attacker.example/jwks' } }))).toMatchObject({ error: 'idp_url_off_issuer' });
    expect(fetched).toEqual([]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM ssoProvider WHERE organizationId = ?').bind(t.orgId).first('n')).toBe(0);
  });

  it('answers discovery failures with 4xx codes, not 500', async () => {
    const t = await tenant();
    const reg = (issuer: string) => t.register({ type: 'oidc', issuer, config: { clientId: 'c', clientSecret: 's' } });

    // No discovery document.
    expect(await errorOf(await reg(`https://none-${seq}.example`))).toMatchObject({ status: 400, error: 'discovery_failed', reason: 'discovery_not_found' });
    // A document for another issuer.
    idpRoutes.push((u) => (u.hostname === `other-${seq}.example` ? Response.json({ issuer: 'https://evil.example', authorization_endpoint: 'https://evil.example/a', token_endpoint: 'https://evil.example/t', jwks_uri: 'https://evil.example/k' }) : undefined));
    expect(await errorOf(await reg(`https://other-${seq}.example`))).toMatchObject({ status: 400, error: 'issuer_mismatch' });
    // Required fields missing.
    idpRoutes.push((u) => (u.hostname === `partial-${seq}.example` ? Response.json({ issuer: `https://partial-${seq}.example` }) : undefined));
    expect(await errorOf(await reg(`https://partial-${seq}.example`))).toMatchObject({ status: 400, error: 'discovery_failed', reason: 'discovery_incomplete' });
    // A discovered endpoint that isn't an allowed IdP URL (private address, plain http, ours).
    for (const token_endpoint of ['https://10.0.0.1/token', 'http://plain.example/token', `https://api.${env.INSTANCE_DOMAIN}/token`]) {
      idpRoutes = [];
      idp(`https://bad-${seq}.example`, { token_endpoint });
      expect(await errorOf(await reg(`https://bad-${seq}.example`))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
    }
    // A redirecting discovery endpoint is not followed.
    idpRoutes = [(u) => (u.hostname === `moved-${seq}.example` ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) : undefined)];
    expect(await errorOf(await reg(`https://moved-${seq}.example`))).toMatchObject({ status: 400, error: 'discovery_failed' });
    // An IdP that only takes private_key_jwt.
    idpRoutes = [];
    idp(`https://pkjwt-${seq}.example`, { token_endpoint_auth_methods_supported: ['private_key_jwt'] });
    expect(await errorOf(await reg(`https://pkjwt-${seq}.example`))).toMatchObject({ status: 400, error: 'discovery_failed', reason: 'unsupported_token_auth_method' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM ssoProvider WHERE organizationId = ?').bind(t.orgId).first('n')).toBe(0);
  });

  it('signs a member in through the connector, without trusting the IdP as a redirect target', async () => {
    const t = await tenant();
    const issuer = `https://login.signin-${seq}.example`;
    const providerId = `sso-signin-${seq}`;
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const email = `bob@${t.domain}`;
    let tokenRequest: URLSearchParams | null = null;
    idp(issuer);
    idpRoutes.push(async (u, init) => {
      if (u.href === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      if (u.href === `${issuer}/token`) {
        tokenRequest = new URLSearchParams(String(init?.body));
        const idToken = await new SignJWT({ email, name: 'Bob', email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience('cid')
          .setSubject('idp-user-bob')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        return Response.json({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 300 });
      }
      return undefined;
    });
    expect((await t.register({ type: 'oidc', providerId, issuer, config: { clientId: 'cid', clientSecret: 'shh' } })).status).toBe(201);

    // The IdP's origin is not a trusted callback URL: registering it opened no redirect.
    const evil = await req('POST', '/api/auth/sign-in/sso', { providerId, callbackURL: `${issuer}/steal` });
    expect(evil.status).toBe(403);

    const start = await req('POST', '/api/auth/sign-in/sso', { email, callbackURL: '/' });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('cid');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/sso/callback/${providerId}`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

    const state = authorize.searchParams.get('state')!;
    const cb = await SELF.fetch(`${ORIGIN}/api/auth/sso/callback/${providerId}?code=the-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiesOf(start) },
      redirect: 'manual',
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toMatch(/^\/$|^http:\/\/app\.localhost:\d+\/?$/);
    expect(tokenRequest!.get('code')).toBe('the-code');
    expect(tokenRequest!.get('client_secret')).toBe('shh'); // client_secret_post, as discovered

    const session = cookiesOf(cb);
    const me = (await (await req('GET', '/api/me', undefined, session)).json()) as { user: { email: string }; session: { method: string } };
    expect(me).toMatchObject({ user: { email }, session: { method: 'sso' } });
    const row = await env.DB.prepare("SELECT ssoOrgId FROM session WHERE method = 'sso' ORDER BY createdAt DESC LIMIT 1").first<{ ssoOrgId: string }>();
    expect(row!.ssoOrgId).toBe(t.orgId);
    // The org's SSO brought Bob in as a tenant user of that org.
    const member = await env.DB.prepare('SELECT m.role FROM member m JOIN session s ON s.userId = m.userId WHERE s.ssoOrgId = ? AND m.organizationId = ?')
      .bind(t.orgId, t.orgId)
      .first<{ role: string }>();
    expect(member?.role).toBe('tenant_user');
  });
});

// ---- SAML ----------------------------------------------------------------------------------------

const certBody = IDP_CERT.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
const metadataXml = (entityID: string, sso: string) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityID}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${sso}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${sso}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('SAML registration', () => {
  it('takes the IdP metadata XML; the entity id comes from it', async () => {
    const t = await tenant();
    const providerId = `sso-samlmd-${seq}`;
    const entityID = `https://sts.idp-${seq}.example/tenant/`;
    const res = await t.register({ type: 'saml', providerId, config: { idpMetadata: { metadata: metadataXml(entityID, `https://sts.idp-${seq}.example/saml2`) } } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      redirectUrl: `${ORIGIN}/api/auth/sso/saml2/sp/acs/${providerId}`,
      metadataUrl: `${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`,
    });
    expect(fetched).toEqual([]);
    const p = await storedProvider(providerId);
    expect(p).toMatchObject({ organizationId: t.orgId, issuer: entityID, domainVerified: true });
    expect(p!.samlConfig).toMatchObject({
      entryPoint: `https://sts.idp-${seq}.example/saml2`,
      idpMetadata: { metadata: expect.stringContaining(entityID) },
      spMetadata: { entityID: `${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}` },
    });

    // The SP metadata the admin hands the IdP names our entity id and ACS.
    const sp = await SELF.fetch(`${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`);
    expect(sp.status).toBe(200);
    const xml = await sp.text();
    expect(xml).toContain(`entityID="${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}"`);
    expect(xml).toContain(`/api/auth/sso/saml2/sp/acs/${providerId}`);

    // Sign-in sends the browser to the IdP's HTTP-Redirect sign-on URL.
    const start = await req('POST', '/api/auth/sign-in/sso', { providerId, callbackURL: '/' });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { url: string }).url).toMatch(new RegExp(`^https://sts\\.idp-${seq}\\.example/saml2\\?SAMLRequest=`));
  });

  it('takes the entity id, sign-on URL and certificate by hand (the issuer is the entity id)', async () => {
    const t = await tenant();
    const providerId = `sso-samlman-${seq}`;
    // Okta's entity ids are http URLs; they are names, never fetched.
    const entityID = `http://www.okta.com/exk${seq}`;
    const res = await t.register({ type: 'saml', providerId, issuer: entityID, config: { entryPoint: `https://acme-${seq}.okta.example/app/sso/saml`, cert: IDP_CERT, wantAssertionsSigned: true } });
    expect(res.status).toBe(201);
    const p = await storedProvider(providerId);
    expect(p).toMatchObject({ issuer: entityID, organizationId: t.orgId });
    expect(p!.samlConfig).toMatchObject({ entryPoint: `https://acme-${seq}.okta.example/app/sso/saml`, cert: IDP_CERT, wantAssertionsSigned: true, idpMetadata: { entityID } });

    // The same through idpMetadata.
    const res2 = await t.register({
      type: 'saml',
      providerId: `${providerId}-b`,
      config: {
        idpMetadata: {
          entityID,
          cert: IDP_CERT,
          singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `https://acme-${seq}.okta.example/app/sso/saml` }],
        },
      },
    });
    expect(res2.status).toBe(201);
  });

  it('accepts opaque entity ids (http, urn): they are names, never fetched or redirected to', async () => {
    const t = await tenant();
    const sso = `https://idp-${seq}.saml.example/sso`;
    const cases: [string, Record<string, unknown>, string | undefined][] = [
      // Okta: an http URL as the entity id, given as the issuer.
      [`http://www.okta.com/exk${seq}abc`, { entryPoint: sso, cert: IDP_CERT }, `http://www.okta.com/exk${seq}abc`],
      // urn: entity id as the issuer, and inside idpMetadata.
      [`urn:example:idp:${seq}`, { entryPoint: sso, cert: IDP_CERT }, `urn:example:idp:${seq}`],
      [`urn:example:idp:${seq}:b`, { idpMetadata: { entityID: `urn:example:idp:${seq}:b`, cert: IDP_CERT }, entryPoint: sso }, undefined],
      // ... and both named only by metadata XML.
      [`http://www.okta.com/exk${seq}md`, { idpMetadata: { metadata: metadataXml(`http://www.okta.com/exk${seq}md`, sso) } }, undefined],
      [`urn:example:idp:${seq}:md`, { idpMetadata: { metadata: metadataXml(`urn:example:idp:${seq}:md`, sso) } }, undefined],
    ];
    let n = 0;
    for (const [entityID, config, issuer] of cases) {
      const providerId = `sso-opaque-${seq}-${++n}`;
      const res = await t.register({ type: 'saml', providerId, ...(issuer ? { issuer } : {}), config });
      expect(res.status, `${entityID}: ${await res.clone().text()}`).toBe(201);
      const p = await storedProvider(providerId);
      expect(p).toMatchObject({ issuer: entityID, organizationId: t.orgId });
      // Our SP entity id stays our metadata URL, whatever the IdP's is.
      expect(p!.samlConfig).toMatchObject({ spMetadata: { entityID: `${ORIGIN}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}` } });
      const start = await req('POST', '/api/auth/sign-in/sso', { providerId, callbackURL: '/' });
      expect(start.status).toBe(200);
      expect(((await start.json()) as { url: string }).url.startsWith(`${sso}?SAMLRequest=`)).toBe(true);
    }
    expect(fetched).toEqual([]);
    // The sign-on URL is still checked: http there is refused.
    expect(await errorOf(await t.register({ type: 'saml', issuer: `urn:example:idp:${seq}:x`, config: { entryPoint: `http://idp-${seq}.saml.example/sso`, cert: IDP_CERT } }))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
  });

  it('refuses incomplete or inconsistent SAML settings with 4xx codes', async () => {
    const t = await tenant();
    const reg = (issuer: string | undefined, config: Record<string, unknown>) => t.register({ type: 'saml', ...(issuer ? { issuer } : {}), config });
    const sso = 'https://idp.saml.example/sso';
    expect(await errorOf(await reg(undefined, { entryPoint: sso, cert: IDP_CERT }))).toMatchObject({ status: 400, error: 'entity_id_required' });
    expect(await errorOf(await reg('https://idp.saml.example', { cert: IDP_CERT }))).toMatchObject({ status: 400, error: 'sso_url_required' });
    expect(await errorOf(await reg('https://idp.saml.example', { entryPoint: sso }))).toMatchObject({ status: 400, error: 'cert_required' });
    expect(await errorOf(await reg('https://idp.saml.example', { entryPoint: sso, cert: 'not a certificate' }))).toMatchObject({ status: 400, error: 'invalid_certificate' });
    expect(await errorOf(await reg('https://idp.saml.example', { entryPoint: 'http://idp.saml.example/sso', cert: IDP_CERT }))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
    expect(await errorOf(await reg('https://idp.saml.example', { entryPoint: 'https://10.0.0.1/sso', cert: IDP_CERT }))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
    expect(await errorOf(await reg(undefined, { idpMetadata: { metadata: '<not-metadata/>' } }))).toMatchObject({ status: 400, error: 'invalid_idp_config' });
    expect(await errorOf(await reg(undefined, { idpMetadata: { metadata: metadataXml('https://idp.saml.example', 'http://idp.saml.example/sso') } }))).toMatchObject({ status: 400, error: 'idp_url_not_allowed' });
    expect(await errorOf(await reg('https://other.example', { idpMetadata: { metadata: metadataXml('https://idp.saml.example', sso) } }))).toMatchObject({ status: 400, error: 'issuer_mismatch' });
    // Unknown fields (e.g. an SP private key, or trusted fields) never reach the plugin.
    expect((await reg('https://idp.saml.example', { entryPoint: sso, cert: IDP_CERT, privateKey: 'x' })).status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM ssoProvider WHERE organizationId = ?').bind(t.orgId).first('n')).toBe(0);
  });
});

// ---- error mapping and URL rule, directly ----------------------------------------------------------

describe('SSO error mapping', () => {
  it("maps the plugin's errors to stable 4xx codes", () => {
    expect(ssoRegistrationFailure(new APIError('BAD_REQUEST', { message: 'SAML configuration requires ...' }))).toMatchObject({ status: 400, code: 'invalid_idp_config', detail: 'SAML configuration requires ...' });
    expect(ssoRegistrationFailure(new APIError('UNPROCESSABLE_ENTITY', { message: 'SSO provider with this providerId already exists' }))).toMatchObject({ status: 409, code: 'provider_id_taken' });
    expect(ssoRegistrationFailure(new APIError('FORBIDDEN', { message: 'You have reached the maximum number of SSO providers' }))).toMatchObject({ status: 409, code: 'sso_provider_limit' });
    expect(ssoRegistrationFailure(new DiscoveryError('discovery_timeout', 'timed out'))).toMatchObject({ status: 400, code: 'discovery_failed', reason: 'discovery_timeout' });
    expect(ssoRegistrationFailure(new DiscoveryError('discovery_untrusted_origin', 'no'))).toMatchObject({ status: 400, code: 'idp_url_not_allowed' });
    expect(ssoRegistrationFailure(new APIError('INTERNAL_SERVER_ERROR'))).toBeNull();
    expect(ssoRegistrationFailure(new Error('boom'))).toBeNull();
    // Anything that does escape still isn't a 500 when it is the client's (index.ts onError).
    expect(clientError(new APIError('BAD_REQUEST', { code: 'SAML_INVALID_SP_METADATA', message: 'x' }))).toEqual({ status: 400, code: 'saml_invalid_sp_metadata' });
  });

  it('allows loopback IdPs over http only in local development', () => {
    const local = { APP_ORIGIN: 'http://app.localhost:8787', INSTANCE_DOMAIN: 'run.localhost', LOCAL_DEV: '1' };
    const prod = { APP_ORIGIN: 'https://app.worca.dev', INSTANCE_DOMAIN: 'worca.run' };
    expect(idpUrlAllowed(local, 'http://127.0.0.1:9123/idp')).toBe(true);
    expect(idpUrlAllowed(local, 'http://localhost:9123/idp')).toBe(true);
    expect(idpUrlAllowed(local, 'http://app.localhost:8787/x')).toBe(false);
    expect(idpUrlAllowed(local, 'http://idp.example/x')).toBe(false);
    expect(idpUrlAllowed(prod, 'http://127.0.0.1:9123/idp')).toBe(false);
    expect(idpUrlAllowed(prod, 'https://localhost/idp')).toBe(false);
    expect(idpUrlAllowed(prod, 'https://login.microsoftonline.com/t/v2.0')).toBe(true);
    expect(idpUrlAllowed(prod, 'https://app.worca.dev/x')).toBe(false);
    expect(idpUrlAllowed(prod, 'https://a.worca.run/x')).toBe(false);
  });
});

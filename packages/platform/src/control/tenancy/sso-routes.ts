// An org's SSO connectors (D22): reading and removing them, and turning a tenant admin's connector
// settings into what the Better Auth SSO plugin registers (the POST route itself is in domains.ts,
// next to the domain it needs). The list never returns connector settings: client secrets,
// certificates and endpoints stay in the encrypted oidcConfig/samlConfig columns.
import { Hono } from 'hono';
import { socialProviderList } from 'better-auth/social-providers';
import { deriveSAMLIdentityProviderEntityID, DiscoveryError, discoverOIDCConfig } from '@better-auth/sso';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { isForeignHost, isPublicHost, normalizeHost, siteOf } from './safe-url';
import { dropGateSessionsForUser } from '../gate-client';
import { auditOrg } from './audit';
import { registerConfirmAction, startConfirmation } from './confirmations';
import { currentPolicyState, describeAffected, lockOutReport } from './policy';
import { lockOutConfirmationSent, lockOutRefusal } from './policy-routes';
import { requireMfa, requireOrgRole } from './roles';
import { actor, domainIndex, fail, field, LOGIN_METHODS, orgOwner, ssoDomainIndex, tryDecrypt } from './util';

export const ssoApp = new Hono<AppContext>();

/**
 * account.providerId values of Better Auth's own sign-in methods. The SSO plugin creates accounts
 * under the provider's providerId, so an SSO provider holding one of these would share (and on
 * removal, delete) the accounts of every user of that method, across orgs.
 */
const RESERVED_PROVIDER_IDS = new Set<string>([...socialProviderList, ...LOGIN_METHODS, 'credential', 'email', 'sso-foreign', 'magic-link', 'anonymous', 'phone-number']);
export const isReservedProviderId = (id: string): boolean => RESERVED_PROVIDER_IDS.has(id.trim().toLowerCase());

/** New providerIds: the 'sso-' prefix keeps them apart from every built-in provider id. */
export const SSO_PROVIDER_ID_RE = /^sso-[a-z0-9-]{3,40}$/;

/** A providerId is free when no provider has it and no account (even one left behind) uses it. */
export async function providerIdTaken(env: Env, providerId: string): Promise<boolean> {
  if (isReservedProviderId(providerId)) return true;
  const sso = await env.DB.prepare('SELECT 1 FROM ssoProvider WHERE providerId = ?').bind(providerId).first();
  const acct = await env.DB.prepare('SELECT 1 FROM account WHERE providerId = ? LIMIT 1').bind(providerId).first();
  return !!sso || !!acct;
}

interface SsoRow {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
  domainVerified: number | null;
  createdAt: number | null;
  kind: 'oidc' | 'saml' | null;
}

// Only what the list shows; the config columns are reduced to which one is set.
const SSO_COLUMNS = `id, providerId, issuer, domain, domainVerified, createdAt,
  CASE WHEN samlConfig IS NOT NULL THEN 'saml' WHEN oidcConfig IS NOT NULL THEN 'oidc' ELSE NULL END AS kind`;

const ssoDomainField = (orgId: string, id: string) => field('ssoProvider', 'domain', id, orgOwner(orgId));

/** Better Auth's routes: baseURL is APP_ORIGIN, basePath /api/auth (auth/index.ts). */
export function ssoEndpoints(env: Env, providerId: string, type: 'oidc' | 'saml' | null) {
  const base = `${new URL(env.APP_ORIGIN).origin}/api/auth`;
  const id = encodeURIComponent(providerId);
  if (type === 'saml') {
    return {
      // Assertion consumer service (the "reply URL") and the SP metadata to hand the IdP.
      redirectUrl: `${base}/sso/saml2/sp/acs/${id}`,
      metadataUrl: `${base}/sso/saml2/sp/metadata?providerId=${id}`,
    };
  }
  return { redirectUrl: `${base}/sso/callback/${id}` }; // @better-auth/sso getOIDCRedirectURI
}

// ---- registration: request shapes, IdP URL trust, OIDC discovery, SAML shaping ----------------
//
// How IdP origins are trusted (security.md "Org SSO connectors"). The SSO plugin checks every IdP
// URL it fetches against an isTrustedOrigin predicate. Inside its /sso/register endpoint that
// predicate is Better Auth's global `trustedOrigins`, which holds only our own origin and also
// decides which callbackURL / redirect targets and request origins are accepted. Adding tenant
// IdP origins there (statically, or through a trustedOrigins function) would make every
// tenant-chosen origin a valid post-login redirect target and a trusted request origin, for every
// flow. So the global list stays as it is, and registration runs discovery itself, through the
// plugin's own discoverOIDCConfig with a predicate scoped to this one call (idpUrlAllowed below:
// https, a public name, not ours). The resolved endpoints go to the plugin with skipDiscovery, so
// the plugin never needs to trust them: it only fetches public hosts at sign-in (token, JWKS,
// userinfo), which it allows without trustedOrigins, and never re-runs discovery for a provider
// that has all three endpoints stored.

/** Thrown while preparing a registration; the route answers `{ error, reason?, detail? }`. */
export class SsoConfigError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    readonly detail?: string,
    readonly reason?: string,
  ) {
    super(code);
    this.name = 'SsoConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An IdP URL the control plane may send people to or fetch: https on a public name that isn't
 * ours. Under wrangler dev (LOCAL_DEV) a loopback IdP over http is allowed too, for local tests.
 */
export function idpUrlAllowed(env: Pick<Env, 'INSTANCE_DOMAIN' | 'APP_ORIGIN' | 'LOCAL_DEV'>, value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || !isForeignHost(env, url.hostname)) return false;
  if (url.protocol === 'https:' && isPublicHost(url.hostname)) return true;
  return env.LOCAL_DEV === '1' && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(normalizeHost(url.hostname));
}

const url = z.string().min(1).max(2000);
const pem = z.string().min(1).max(20_000);
const certs = z.union([pem, z.array(pem).min(1).max(5)]);

// Only the connector settings a tenant admin may set; strict, so nothing else reaches the plugin.
// URL fields are checked against the environment (idpUrlAllowed) in prepareSsoRegistration.
export const oidcConfigSchema = z
  .object({
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    discoveryEndpoint: url.optional(),
    /** Use the endpoints below as given; authorization, token and JWKS endpoints are then required. */
    skipDiscovery: z.boolean().optional(),
    authorizationEndpoint: url.optional(),
    tokenEndpoint: url.optional(),
    jwksEndpoint: url.optional(),
    userInfoEndpoint: url.optional(),
    tokenEndpointAuthentication: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
    scopes: z.array(z.string().min(1).max(100)).max(20).optional(),
    pkce: z.boolean().optional(),
    mapping: z.object({ email: z.string().min(1).max(100), name: z.string().min(1).max(100), image: z.string().min(1).max(100).optional() }).strict().optional(),
  })
  .strict();

export const samlConfigSchema = z
  .object({
    /** IdP metadata XML, or the IdP's entity id, sign-on service and certificate by hand. */
    idpMetadata: z
      .object({
        metadata: z.string().min(1).max(100_000).optional(),
        entityID: z.string().min(1).max(500).optional(),
        singleSignOnService: z.array(z.object({ Binding: z.string().min(1).max(200), Location: url }).strict()).min(1).max(5).optional(),
        cert: certs.optional(),
      })
      .strict()
      .optional(),
    /** The IdP's sign-on URL (HTTP-Redirect binding); same as one idpMetadata.singleSignOnService. */
    entryPoint: url.optional(),
    cert: certs.optional(),
    audience: z.string().min(1).max(500).optional(),
    identifierFormat: z.string().min(1).max(200).optional(),
    wantAssertionsSigned: z.boolean().optional(),
    mapping: z
      .object({
        email: z.string().min(1).max(200),
        name: z.string().min(1).max(200),
        firstName: z.string().min(1).max(200).optional(),
        lastName: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const providerIdField = z.string().regex(SSO_PROVIDER_ID_RE).optional();
export const ssoRegistrationSchema = z.discriminatedUnion('type', [
  // OIDC: issuer is the IdP's issuer URL (discovery base, and the id token's iss).
  z.object({ type: z.literal('oidc'), domainId: z.string().min(1), providerId: providerIdField, issuer: url, config: oidcConfigSchema }).strict(),
  // SAML: issuer is the IdP's entity id; optional when the metadata XML names it.
  z.object({ type: z.literal('saml'), domainId: z.string().min(1), providerId: providerIdField, issuer: z.string().min(1).max(500).optional(), config: samlConfigSchema }).strict(),
]);
export type SsoRegistration = z.infer<typeof ssoRegistrationSchema>;
type OidcInput = z.infer<typeof oidcConfigSchema>;
type SamlInput = z.infer<typeof samlConfigSchema>;

const SAML_REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
/** Without a refresh token to keep, offline_access (the plugin's default) only breaks Google. */
const DEFAULT_OIDC_SCOPES = ['openid', 'email', 'profile'];

function assertIdpUrl(env: Env, value: string, what: string): void {
  if (!idpUrlAllowed(env, value)) throw new SsoConfigError(400, 'idp_url_not_allowed', `${what} must be an https URL on a public host that isn't ours.`);
}

/**
 * Checks a registration and returns the issuer and the plugin config to register. OIDC endpoints
 * given by hand must be on the issuer's site; discovery fills in the rest later
 * (discoverOidcEndpoints). SAML is shaped completely here: nothing of it is fetched.
 */
export function prepareSsoRegistration(env: Env, body: SsoRegistration, providerId: string): { issuer: string; config: Record<string, unknown> } {
  if (body.type === 'oidc') {
    assertIdpUrl(env, body.issuer, 'The issuer');
    const c = body.config;
    const site = siteOf(new URL(body.issuer).hostname);
    for (const key of ['discoveryEndpoint', 'authorizationEndpoint', 'tokenEndpoint', 'jwksEndpoint', 'userInfoEndpoint'] as const) {
      const v = c[key];
      if (!v) continue;
      assertIdpUrl(env, v, key);
      if (siteOf(new URL(v).hostname) !== site) throw new SsoConfigError(400, 'idp_url_off_issuer', `${key} must be on the issuer's site (${site}); leave it out to take it from discovery.`);
    }
    if (c.skipDiscovery && (!c.authorizationEndpoint || !c.tokenEndpoint || !c.jwksEndpoint)) {
      throw new SsoConfigError(400, 'endpoints_required', 'Without discovery, authorizationEndpoint, tokenEndpoint and jwksEndpoint are required.');
    }
    const oidcConfig: OidcInput = { ...c, scopes: c.scopes?.length ? c.scopes : DEFAULT_OIDC_SCOPES, pkce: c.pkce ?? true };
    return { issuer: body.issuer, config: { oidcConfig } };
  }
  return prepareSaml(env, body.issuer, body.config, providerId);
}

/** The first HTTP-Redirect SingleSignOnService Location in IdP metadata XML. */
function redirectSsoLocation(xml: string): string | undefined {
  for (const tag of xml.match(/<(?:[\w-]+:)?SingleSignOnService\b[^>]*>/g) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
    const binding = attr('Binding');
    const location = attr('Location');
    if ((binding?.[2] ?? binding?.[3]) === SAML_REDIRECT_BINDING && location) return location[2] ?? location[3];
  }
  return undefined;
}

/** A PEM (or bare base64) X.509 certificate: base64 of a DER SEQUENCE. */
function looksLikeCert(value: string): boolean {
  const b64 = value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length < 100) return false;
  try {
    return atob(b64).charCodeAt(0) === 0x30;
  } catch {
    return false;
  }
}

function prepareSaml(env: Env, issuer: string | undefined, c: SamlInput, providerId: string): { issuer: string; config: Record<string, unknown> } {
  const metadata = c.idpMetadata?.metadata;
  const cert = c.idpMetadata?.cert ?? c.cert;
  for (const v of [cert ?? []].flat()) if (!looksLikeCert(v)) throw new SsoConfigError(400, 'invalid_certificate', 'The signing certificate must be a PEM-encoded X.509 certificate.');
  if (c.entryPoint) assertIdpUrl(env, c.entryPoint, 'The sign-on URL');
  for (const s of c.idpMetadata?.singleSignOnService ?? []) assertIdpUrl(env, s.Location, 'The sign-on URL');
  // The SP's entity id: our metadata URL, stable per connector. (The plugin would otherwise use
  // `issuer`, which here is the IdP's.) The IdP sends it as the assertion's audience.
  const spMetadata = { entityID: ssoEndpoints(env, providerId, 'saml').metadataUrl };
  const options = {
    ...(c.audience ? { audience: c.audience } : {}),
    ...(c.identifierFormat ? { identifierFormat: c.identifierFormat } : {}),
    ...(c.wantAssertionsSigned !== undefined ? { wantAssertionsSigned: c.wantAssertionsSigned } : {}),
    ...(c.mapping ? { mapping: c.mapping } : {}),
    spMetadata,
  };

  let entityID: string;
  let samlConfig: Record<string, unknown>;
  if (metadata) {
    if (c.idpMetadata?.entityID || c.idpMetadata?.singleSignOnService || c.entryPoint) {
      throw new SsoConfigError(400, 'invalid_idp_config', 'Give either the IdP metadata XML, or the entity id, sign-on URL and certificate; not both.');
    }
    try {
      entityID = deriveSAMLIdentityProviderEntityID({ idpMetadata: { metadata } } as never);
    } catch {
      throw new SsoConfigError(400, 'invalid_idp_config', 'The IdP metadata XML could not be read.', 'saml_metadata_invalid');
    }
    if (!entityID) throw new SsoConfigError(400, 'invalid_idp_config', 'The IdP metadata XML has no entityID.', 'saml_metadata_invalid');
    // Sign-in sends an AuthnRequest with the HTTP-Redirect binding; the plugin also wants it as entryPoint.
    const entryPoint = redirectSsoLocation(metadata);
    if (!entryPoint) throw new SsoConfigError(400, 'invalid_idp_config', 'The IdP metadata XML has no HTTP-Redirect SingleSignOnService.', 'saml_sso_url_missing');
    assertIdpUrl(env, entryPoint, 'The sign-on URL in the metadata');
    samlConfig = { entryPoint, ...(cert ? { cert } : {}), idpMetadata: { metadata }, ...options };
  } else {
    entityID = c.idpMetadata?.entityID ?? issuer ?? '';
    if (!entityID) throw new SsoConfigError(400, 'entity_id_required', "Give the IdP's entity id (issuer), or its metadata XML.");
    const services = c.idpMetadata?.singleSignOnService;
    const entryPoint = services?.find((s) => s.Binding === SAML_REDIRECT_BINDING)?.Location ?? c.entryPoint;
    if (!entryPoint) throw new SsoConfigError(400, 'sso_url_required', "Give the IdP's sign-on URL (HTTP-Redirect binding), or its metadata XML.");
    if (!cert) throw new SsoConfigError(400, 'cert_required', "Give the IdP's signing certificate, or its metadata XML.");
    samlConfig = { entryPoint, cert, idpMetadata: { entityID, ...(services ? { singleSignOnService: services } : {}) }, ...options };
  }
  if (issuer && issuer !== entityID) throw new SsoConfigError(400, 'issuer_mismatch', `The metadata names the IdP "${entityID}", not "${issuer}".`);
  return { issuer: entityID, config: { samlConfig } };
}

/**
 * OIDC discovery with the trust predicate scoped to this registration (see the comment above):
 * the discovery document and every endpoint it lists must pass idpUrlAllowed. Endpoints given by
 * hand win over discovered ones. Returns the plugin config with every endpoint filled in and
 * skipDiscovery set, so the plugin's register endpoint doesn't fetch (or trust) anything itself.
 */
export async function discoverOidcEndpoints(env: Env, issuer: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const c = config as OidcInput;
  if (c.skipDiscovery) return { ...c, tokenEndpointAuthentication: c.tokenEndpointAuthentication ?? 'client_secret_basic', skipDiscovery: true };
  let found: Awaited<ReturnType<typeof discoverOIDCConfig>>;
  try {
    found = await discoverOIDCConfig({
      issuer,
      discoveryEndpoint: c.discoveryEndpoint,
      existingConfig: {
        discoveryEndpoint: c.discoveryEndpoint,
        authorizationEndpoint: c.authorizationEndpoint,
        tokenEndpoint: c.tokenEndpoint,
        jwksEndpoint: c.jwksEndpoint,
        userInfoEndpoint: c.userInfoEndpoint,
        tokenEndpointAuthentication: c.tokenEndpointAuthentication,
      },
      isTrustedOrigin: (u: string) => idpUrlAllowed(env, u),
    });
  } catch (err) {
    if (err instanceof DiscoveryError) throw discoveryFailure(err);
    throw err;
  }
  if (found.tokenEndpointAuthentication === 'private_key_jwt') {
    throw new SsoConfigError(400, 'discovery_failed', 'The IdP supports only private_key_jwt client authentication; use a client secret.', 'unsupported_token_auth_method');
  }
  return {
    ...c,
    discoveryEndpoint: found.discoveryEndpoint,
    authorizationEndpoint: found.authorizationEndpoint,
    tokenEndpoint: found.tokenEndpoint,
    jwksEndpoint: found.jwksEndpoint,
    ...(found.userInfoEndpoint ? { userInfoEndpoint: found.userInfoEndpoint } : {}),
    tokenEndpointAuthentication: found.tokenEndpointAuthentication,
    skipDiscovery: true,
  };
}

function discoveryFailure(err: DiscoveryError): SsoConfigError {
  switch (err.code) {
    case 'discovery_untrusted_origin':
    case 'discovery_private_host':
    case 'discovery_invalid_url':
      return new SsoConfigError(400, 'idp_url_not_allowed', err.message, err.code);
    case 'issuer_mismatch':
      return new SsoConfigError(400, 'issuer_mismatch', err.message, err.code);
    default: // not_found, timeout, unexpected_error, invalid_json, incomplete, oidc_endpoint_redirect, ...
      return new SsoConfigError(400, 'discovery_failed', err.message, err.code);
  }
}

/**
 * Errors the plugin's register endpoint raises (better-call APIError: string status, numeric
 * statusCode, body.message), as stable codes. Anything else is not the admin's to fix: rethrown.
 */
export function ssoRegistrationFailure(err: unknown): SsoConfigError | null {
  if (err instanceof SsoConfigError) return err;
  if (err instanceof DiscoveryError) return discoveryFailure(err);
  const e = err as { statusCode?: unknown; body?: { message?: unknown; code?: unknown } } | null;
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 0;
  const detail = typeof e?.body?.message === 'string' ? e.body.message : undefined;
  const reason = typeof e?.body?.code === 'string' ? e.body.code.toLowerCase() : undefined;
  if (status === 422) return new SsoConfigError(409, 'provider_id_taken', detail, reason); // reserved or existing providerId
  if (status === 403) return new SsoConfigError(409, 'sso_provider_limit', detail, reason); // providersLimit per registering user
  if (status === 400) return new SsoConfigError(400, 'invalid_idp_config', detail, reason);
  return null;
}

async function present(env: Env, orgId: string, r: SsoRow) {
  return {
    id: r.id,
    providerId: r.providerId,
    type: r.kind,
    issuer: r.issuer,
    domain: await tryDecrypt(env, ssoDomainField(orgId, r.id), r.domain),
    createdAt: r.createdAt ?? null,
    // Registration marks the domain verified (it was proven through org_domains); a provider whose
    // domain was removed from the org stops working until the domain is verified again.
    status: r.domainVerified === 1 ? 'active' : 'domain_unverified',
    ...ssoEndpoints(env, r.providerId, r.kind),
  };
}

ssoApp.get('/:orgId/sso', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const rows = await c.env.DB.prepare(`SELECT ${SSO_COLUMNS} FROM ssoProvider WHERE organizationId = ? ORDER BY createdAt, providerId`)
    .bind(orgId)
    .all<SsoRow>();
  const providers = [];
  for (const r of rows.results) providers.push(await present(c.env, orgId, r));
  return c.json({ providers });
});

/**
 * Removes the provider, the accounts linked through it and the control-plane sessions created
 * through this org's SSO, then those sessions' gate sessions (D46). Sessions record the org, not
 * the provider, so with several providers every SSO session of the org ends; people sign in again.
 */
async function deleteSsoProvider(env: Env, orgId: string, id: string, actorId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${SSO_COLUMNS} FROM ssoProvider WHERE id = ? AND organizationId = ?`).bind(id, orgId).first<SsoRow>();
  if (!row) return false;
  const domain = await tryDecrypt(env, ssoDomainField(orgId, id), row.domain);
  const sessions = await env.DB.prepare("SELECT id, userId FROM session WHERE ssoOrgId = ? AND method = 'sso'")
    .bind(orgId)
    .all<{ id: string; userId: string }>();
  if (isReservedProviderId(row.providerId)) return false; // never touch built-in accounts
  await env.DB.batch([
    // Only this org's members: accounts of anyone else stay, and keep the id from being reused.
    env.DB.prepare('DELETE FROM account WHERE providerId = ? AND userId IN (SELECT userId FROM member WHERE organizationId = ?)').bind(row.providerId, orgId),
    env.DB.prepare('DELETE FROM ssoProvider WHERE id = ? AND organizationId = ?').bind(id, orgId),
    ...sessions.results.map((s) => env.DB.prepare('DELETE FROM session WHERE id = ?').bind(s.id)),
  ]);
  for (const s of sessions.results) await dropGateSessionsForUser(env, s.userId, { cpSessionId: s.id });
  await auditOrg(env, orgId, {
    actorId,
    actorScope: 'tenant',
    action: 'sso.removed',
    targetType: 'sso',
    targetId: id,
    details: { providerId: row.providerId, type: row.kind, domain, sessionsEnded: sessions.results.length },
  });
  return true;
}

registerConfirmAction(
  'org.sso.delete',
  async (env, _ctx, { userId, orgId, target }) => {
    if (!orgId) throw new Error('org.sso.delete without an org');
    await deleteSsoProvider(env, orgId, target, userId); // already gone: nothing to do
  },
  { label: 'Remove an SSO connection' },
);

/**
 * Why removing this provider is destructive regardless of who is affected today (D31): the
 * policies name SSO and this is the provider that serves it.
 */
async function ssoPolicyDependence(env: Env, orgId: string, row: SsoRow, domain: string | null): Promise<string[]> {
  const state = await currentPolicyState(env, orgId);
  const why: string[] = [];
  if (state.orgAllowed.length > 0 && state.orgAllowed.every((m) => m === 'sso')) why.push('org_policy_sso_only');
  if ([...state.instanceRequired.values()].some((m) => m.includes('sso'))) why.push('instance_policy_requires_sso');
  if (state.requiredDomainIndex && domain && row.domainVerified === 1 && (state.orgAllowed.length === 0 || state.orgAllowed.includes('sso'))) {
    const others = await env.DB.prepare('SELECT 1 FROM ssoProvider WHERE organizationId = ? AND domainVerified = 1 AND domainIndex = ? AND id != ?')
      .bind(orgId, await ssoDomainIndex(env, domain), row.id)
      .first();
    if (!others && (await domainIndex(env, domain)) === state.requiredDomainIndex) why.push('required_domain_served_by_sso');
  }
  return why;
}

ssoApp.delete('/:orgId/sso/:id', requireOrgRole('tenant_admin'), requireMfa, async (c) => {
  const orgId = c.req.param('orgId');
  const id = c.req.param('id');
  const { user } = actor(c);
  let confirmName: string | undefined;
  const raw = await c.req.text();
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail(400, 'invalid_json');
    }
    const body = z.object({ confirmName: z.string().optional() }).safeParse(parsed);
    if (!body.success) fail(400, 'invalid_body');
    confirmName = body.data.confirmName;
  }
  const row = await c.env.DB.prepare(`SELECT ${SSO_COLUMNS} FROM ssoProvider WHERE id = ? AND organizationId = ?`).bind(id, orgId).first<SsoRow>();
  if (!row) fail(404, 'not_found');
  // Registered before ids were checked (domains.ts): removing it would mean deleting accounts of a
  // built-in method. Support handles these.
  if (isReservedProviderId(row.providerId)) fail(409, 'provider_id_reserved');
  const domain = await tryDecrypt(c.env, ssoDomainField(orgId, id), row.domain);

  const state = await currentPolicyState(c.env, orgId);
  const affected = await lockOutReport(c.env, orgId, state, state, { removeSsoProviderId: id });
  const dependence = await ssoPolicyDependence(c.env, orgId, row, domain);
  if (affected.length === 0 && dependence.length === 0) {
    await deleteSsoProvider(c.env, orgId, id, user.id);
    return c.json({ ok: true });
  }
  // The admin types the connector's providerId (D30).
  const refused = lockOutRefusal(c, affected, confirmName, row.providerId, { policyDependence: dependence });
  if (refused) return refused;
  const started = await startConfirmation(c.env, {
    userId: user.id,
    orgId,
    action: 'org.sso.delete',
    target: id,
    summary:
      `Remove the SSO connection "${row.providerId}" (${domain ?? 'unknown domain'}).` +
      (dependence.length ? ' The login policy depends on SSO.' : '') +
      (affected.length ? ` ${affected.length} member(s) would no longer be able to sign in: ${describeAffected(affected)}.` : ''),
  });
  return lockOutConfirmationSent(c, started, affected, { policyDependence: dependence });
});

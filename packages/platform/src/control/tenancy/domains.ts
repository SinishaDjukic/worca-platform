// Org domains proven by a DNS TXT record, and SSO connectors tied to them (D22).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { auditOrg } from './audit';
import { deps } from './deps';
import { requireOrgRole } from './roles';
import { prepareSsoRegistration, providerIdTaken, ssoApp, ssoEndpoints, ssoRegistrationFailure, ssoRegistrationSchema } from './sso-routes';
import { actor, DOMAIN_RE, domainIndex, ssoDomainIndex, fail, field, normalizeDomain, orgOwner, parseBody, randomToken, tryDecrypt } from './util';

export const domainsApp = new Hono<AppContext>();

export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
export const TXT_PREFIX = '_worca-verification';
const txtValue = (token: string) => `worca-verification=${token}`;

const domainField = (orgId: string, id: string) => field('org_domains', 'domain', id, orgOwner(orgId));

interface DomainRow {
  id: string;
  org_id: string;
  domain: string;
  domain_index: string;
  verification_token: string;
  verified_at: number | null;
  created_at: number;
}

async function loadDomain(env: Env, orgId: string, id: string): Promise<DomainRow & { plain: string }> {
  const row = await env.DB.prepare('SELECT * FROM org_domains WHERE id = ? AND org_id = ?').bind(id, orgId).first<DomainRow>();
  if (!row) fail(404, 'not_found');
  const plain = await tryDecrypt(env, domainField(orgId, id), row.domain);
  if (!plain) fail(404, 'not_found');
  return { ...row, plain };
}

/** TXT strings of a name through DNS over HTTPS (RFC 8484 JSON form). */
export async function lookupTxt(name: string, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) return [];
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  // A long TXT record arrives as several quoted strings: "abc" "def".
  return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => a.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''));
}

domainsApp.get('/:orgId/domains', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const rows = await c.env.DB.prepare('SELECT * FROM org_domains WHERE org_id = ? ORDER BY created_at').bind(orgId).all<DomainRow>();
  const domains = [];
  for (const r of rows.results) {
    const domain = await tryDecrypt(c.env, domainField(orgId, r.id), r.domain);
    domains.push({ id: r.id, domain, verifiedAt: r.verified_at, txtName: `${TXT_PREFIX}.${domain}`, txtValue: txtValue(r.verification_token) });
  }
  return c.json({ domains });
});

domainsApp.post('/:orgId/domains', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const { domain } = await parseBody(
    c,
    z.object({ domain: z.string().transform(normalizeDomain).refine((d) => DOMAIN_RE.test(d), 'invalid domain') }),
  );
  const idx = await domainIndex(c.env, domain);
  const dup = await c.env.DB.prepare('SELECT 1 FROM org_domains WHERE org_id = ? AND domain_index = ?').bind(orgId, idx).first();
  if (dup) fail(409, 'domain_exists');
  const id = crypto.randomUUID();
  const token = randomToken(24);
  const enc = await deps().keyRing(c.env).encrypt(domainField(orgId, id), domain);
  await c.env.DB.prepare('INSERT INTO org_domains (id, org_id, domain, domain_index, verification_token, verified_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .bind(id, orgId, enc, idx, token, Date.now())
    .run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'domain.added', targetType: 'domain', targetId: id, details: { domain } });
  return c.json({ id, domain, txtName: `${TXT_PREFIX}.${domain}`, txtValue: txtValue(token) }, 201);
});

domainsApp.post('/:orgId/domains/:id/verify', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const d = await loadDomain(c.env, orgId, c.req.param('id'));
  if (d.verified_at) return c.json({ verified: true, verifiedAt: d.verified_at });
  // One org owns a domain: SSO lookups by domain must be unambiguous.
  const taken = await c.env.DB.prepare('SELECT 1 FROM org_domains WHERE domain_index = ? AND verified_at IS NOT NULL AND org_id != ?')
    .bind(d.domain_index, orgId)
    .first();
  const takenBySso = await c.env.DB.prepare('SELECT 1 FROM ssoProvider WHERE domainIndex = ? AND domainVerified = 1 AND (organizationId IS NULL OR organizationId != ?)')
    .bind(await ssoDomainIndex(c.env, d.plain), orgId)
    .first();
  if (taken || takenBySso) fail(409, 'domain_taken');
  const records = await lookupTxt(`${TXT_PREFIX}.${d.plain}`, deps().fetch);
  if (!records.includes(txtValue(d.verification_token))) {
    await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'domain.verify_failed', targetType: 'domain', targetId: d.id });
    fail(422, 'txt_record_not_found');
  }
  const now = Date.now();
  await c.env.DB.prepare('UPDATE org_domains SET verified_at = ? WHERE id = ?').bind(now, d.id).run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'domain.verified', targetType: 'domain', targetId: d.id, details: { domain: d.plain } });
  return c.json({ verified: true, verifiedAt: now });
});

/**
 * Refused while an SSO provider or the org login policy depends on the domain: dropping either
 * could lock members out, which is a destructive change (D31). Remove those first.
 */
domainsApp.delete('/:orgId/domains/:id', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const d = await loadDomain(c.env, orgId, c.req.param('id'));
  const ssoIdx = await ssoDomainIndex(c.env, d.plain);
  const provider = await c.env.DB.prepare('SELECT 1 FROM ssoProvider WHERE organizationId = ? AND domainIndex = ?').bind(orgId, ssoIdx).first();
  const policy = await c.env.DB.prepare('SELECT 1 FROM org_login_policies WHERE org_id = ? AND required_domain_index = ?').bind(orgId, d.domain_index).first();
  if (provider || policy) fail(409, provider ? 'domain_in_use_by_sso' : 'domain_in_use_by_policy');
  await c.env.DB.batch([
    // Belt and braces: nothing of this org stays verified for a domain it no longer proves.
    c.env.DB.prepare('UPDATE ssoProvider SET domainVerified = 0 WHERE organizationId = ? AND domainIndex = ?').bind(orgId, ssoIdx),
    c.env.DB.prepare('DELETE FROM org_domains WHERE id = ?').bind(d.id),
  ]);
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'domain.removed', targetType: 'domain', targetId: d.id, details: { domain: d.plain } });
  return c.json({ ok: true });
});

/**
 * Registers an OIDC or SAML connector through the Better Auth SSO plugin, for a verified domain.
 * Request shapes, IdP URL checks and error codes: sso-routes.ts (prepareSsoRegistration).
 */
domainsApp.post('/:orgId/sso', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const body = await parseBody(c, ssoRegistrationSchema);
  const d = await loadDomain(c.env, orgId, body.domainId);
  if (!d.verified_at) fail(409, 'domain_not_verified');
  const providerId = body.providerId ?? `sso-${crypto.randomUUID().slice(0, 8)}`;
  // Globally unique and never a built-in provider's id: accounts are keyed by it (sso-routes.ts).
  if (await providerIdTaken(c.env, providerId)) fail(409, 'provider_id_taken');
  let res: { id: string };
  let issuer: string;
  try {
    const prepared = prepareSsoRegistration(c.env, body, providerId);
    issuer = prepared.issuer;
    res = await deps().auth.registerSsoProvider(c.env, { headers: c.req.raw.headers, orgId, providerId, domain: d.plain, issuer, config: prepared.config });
  } catch (err) {
    const refused = ssoRegistrationFailure(err);
    if (!refused) throw err;
    return c.json({ error: refused.code, ...(refused.reason ? { reason: refused.reason } : {}), ...(refused.detail ? { detail: refused.detail } : {}) }, refused.status);
  }
  // ssoProvider.createdAt is ours (0014_security.sql); the plugin doesn't set it.
  await c.env.DB.prepare('UPDATE ssoProvider SET createdAt = ? WHERE providerId = ? AND organizationId = ? AND createdAt IS NULL')
    .bind(Date.now(), providerId, orgId)
    .run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'sso.registered', targetType: 'sso', targetId: res.id, details: { providerId, type: body.type, domain: d.plain, issuer } });
  return c.json({ id: res.id, providerId, ...ssoEndpoints(c.env, providerId, body.type) }, 201);
});

// GET /:orgId/sso and DELETE /:orgId/sso/:id
domainsApp.route('/', ssoApp);

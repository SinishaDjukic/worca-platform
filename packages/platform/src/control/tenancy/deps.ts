// What tenancy needs from other modules (auth, keys, instances, email, DNS), behind one seam so
// the modules can be wired, and replaced in tests, without tenancy importing their internals.
import type { Env } from '../env';
import type { KeyRing } from '../keys-api';
import { noticeEmailHtml, sendEmail } from '../auth/email';
import type { MailKind } from '../system/mail';
import { getKeyRing } from '../keys';
import { siteOf } from '../../shared/site';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** For the per-day mail counts; untagged mail counts as a notification (auth/email.ts mailKindOf). */
  kind?: MailKind;
}

/** The Better Auth calls tenancy makes (organization, invitation and SSO plugins). */
export interface AuthOps {
  /** Server-side create; the creator becomes a member (role fixed up to tenant_admin by the caller). */
  createOrganization(env: Env, input: { userId: string; name: string; slug: string }): Promise<{ id: string }>;
  /**
   * Uses the signed-in admin's request headers; Better Auth encrypts the address via the adapter.
   * `resend`: an unexpired pending invitation for the address gets a new expiry and a new email
   * (same id); without one, a new invitation is created.
   */
  createInvitation(
    env: Env,
    input: { headers: Headers; orgId: string; email: string; role: string; teamId?: string; resend?: boolean },
  ): Promise<{ id: string; expiresAt: number }>;
  /** SSO plugin: registers an OIDC or SAML provider for a verified org domain. */
  registerSsoProvider(
    env: Env,
    input: { headers: Headers; orgId: string; providerId: string; domain: string; issuer: string; config: Record<string, unknown> },
  ): Promise<{ id: string }>;
}

export interface InstanceOps {
  /** Audits and notifies the tenant admins itself (instances/api.ts). */
  stopForAbuse(env: Env, instanceId: string, input: { actorId: string; reason: string; actorRole?: string }): Promise<void>;
  liftStop(env: Env, instanceId: string, input: { actorId: string; actorRole?: string }): Promise<void>;
  deleteInstanceNow(env: Env, instanceId: string, input: { actorId: string }): Promise<void>;
}

export interface TenancyDeps {
  keyRing(env: Env): KeyRing;
  sendEmail(env: Env, msg: EmailMessage): Promise<void>;
  auth: AuthOps;
  instances: InstanceOps;
  /** DNS-over-HTTPS lookups for domain verification. */
  fetch: typeof fetch;
}

/**
 * The plugin's register body. Trusted fields last, and stripped from the caller's config, so the
 * config can't override them. No organizationId: the plugin would then require the registering
 * member's role to be "owner" or "admin" (hard-coded), and ours is tenant_admin. The provider is
 * moved to the org right after (registerSsoProvider below).
 */
export function ssoRegistrationBody(input: { providerId: string; domain: string; issuer: string; config: Record<string, unknown> }) {
  const { providerId: _p, issuer: _i, domain: _d, organizationId: _o, ...rest } = input.config;
  return { ...rest, providerId: input.providerId, issuer: input.issuer, domain: input.domain };
}

// auth/index and instances/api are imported lazily: instances/deps imports tenancy, so a static
// import here would make a cycle at module evaluation.
const auth = () => import('../auth/index').then((m) => m.getAuth);
const instances = () => import('../instances/api');
const ssoRoutes = () => import('./sso-routes');

const defaults: TenancyDeps = {
  keyRing: (env) => getKeyRing(env),
  sendEmail: (env, msg) => sendEmail(env, { ...msg, html: msg.html ?? noticeEmailHtml({ subject: msg.subject, text: msg.text, site: siteOf(env) }) }),
  auth: {
    async createOrganization(env, { userId, name, slug }) {
      const org = await (await auth())(env).api.createOrganization({ body: { name, slug, userId } });
      if (!org?.id) throw new Error('organization not created');
      return { id: org.id };
    },
    async createInvitation(env, { headers, orgId, email, role, teamId, resend }) {
      const inv = await (await auth())(env).api.createInvitation({
        headers,
        body: { email, role: role as 'tenant_admin', organizationId: orgId, ...(teamId ? { teamId } : {}), ...(resend ? { resend: true } : {}) },
      });
      return { id: inv.id, expiresAt: new Date(inv.expiresAt).getTime() };
    },
    async registerSsoProvider(env, { headers, orgId, providerId, domain, issuer, config }) {
      const authInstance = (await auth())(env);
      const api = authInstance.api as unknown as {
        registerSSOProvider(input: { headers: Headers; body: Record<string, unknown> }): Promise<{ id?: string; providerId?: string }>;
      };
      // OIDC discovery runs here, with the IdP trust scoped to this provider (sso-routes.ts).
      const body = config.oidcConfig
        ? { ...config, oidcConfig: await (await ssoRoutes()).discoverOidcEndpoints(env, issuer, config.oidcConfig as Record<string, unknown>) }
        : config;
      const res = await api.registerSSOProvider({ headers, body: ssoRegistrationBody({ providerId, domain, issuer, config: body }) });
      // Registered without an org (see ssoRegistrationBody), so its encrypted fields are under the
      // admin's key. Re-written through the adapter with the org set, they move to the org's key.
      const ctx = await authInstance.$context;
      const row = await ctx.adapter.findOne<Record<string, unknown>>({ model: 'ssoProvider', where: [{ field: 'providerId', value: providerId }] });
      if (!row || row.organizationId) throw new Error('registered SSO provider not found');
      try {
        await ctx.adapter.update({
          model: 'ssoProvider',
          where: [{ field: 'id', value: String(row.id) }],
          update: { organizationId: orgId, domain: row.domain, oidcConfig: row.oidcConfig ?? null, samlConfig: row.samlConfig ?? null },
        });
      } catch (err) {
        await env.DB.prepare('DELETE FROM ssoProvider WHERE id = ? AND organizationId IS NULL').bind(String(row.id)).run();
        throw err;
      }
      // The domain was proven through tenancy's own TXT check (org_domains), so the plugin's
      // second verification step is marked done here, for that provider and that domain only.
      // ssoProvider.domain is encrypted; its blind index is the adapter wrapper's (trim + lowercase).
      const domainIndex = await getKeyRing(env).blindIndex(domain.trim().toLowerCase()); // = util.ssoDomainIndex
      await env.DB.prepare('UPDATE ssoProvider SET domainVerified = 1 WHERE providerId = ? AND organizationId = ? AND domainIndex = ?')
        .bind(providerId, orgId, domainIndex)
        .run();
      return { id: res.id ?? res.providerId ?? providerId };
    },
  },
  instances: {
    stopForAbuse: async (env, id, input) => (await instances()).stopForAbuse(env, id, input),
    liftStop: async (env, id, input) => (await instances()).liftStop(env, id, input),
    deleteInstanceNow: async (env, id, input) => (await instances()).deleteInstanceNow(env, id, input),
  },
  fetch: (input, init) => fetch(input, init),
};

let current: TenancyDeps = defaults;

export function deps(): TenancyDeps {
  return current;
}

/** Tests (and the wiring) replace parts of the seam. */
export function setTenancyDeps(patch: Partial<TenancyDeps>): void {
  current = { ...current, ...patch };
}

export function resetTenancyDeps(): void {
  current = defaults;
}

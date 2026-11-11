// The Better Auth instance of the control plane (D22–D25, D50, D54).
import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { createAccessControl, emailOTP, organization } from 'better-auth/plugins';
import { defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import type { Env, SessionInfo } from '../env';
import { getKeyRing } from '../keys';
import { dropGateSessionsForUser } from '../gate-client';
import { auditPlatform } from '../tenancy/audit';
import { createDatabase } from './database';
import { orgInvitationEmail, passkeyAddedEmail, sendEmail, signInCodeEmail } from './email';
import {
  canCreateOrganization,
  decideRegistration,
  RegistrationError,
  signupCodeFrom,
  type RegisteredVia,
  ssoVouches,
  type SsoProviderFacts,
} from './registration';
import { siteOf } from '../../shared/site';

// ---- Tenant roles (D18): every tenant admin is an owner; tenant users only read. -----------

const ac = createAccessControl(defaultStatements);
export const tenantRoles = {
  tenant_admin: ac.newRole(ownerAc.statements),
  tenant_user: ac.newRole(memberAc.statements),
};

// ---- D50: link by email only when the provider vouches for it ----------------------------

/**
 * Whether an OAuth provider vouches for the profile's email address. Google: `email_verified`.
 * Microsoft: only the optional `xms_edov` claim; its `email` is mutable and unverified (nOAuth).
 * Better Auth links an existing account by email only when this is true (trustedProviders is
 * empty, so no provider is trusted by name), and we refuse to create accounts when it's false.
 */
export function emailVouched(providerId: string, profile: Record<string, unknown>): boolean {
  if (providerId === 'google') return profile.email_verified === true;
  if (providerId === 'microsoft') return profile.xms_edov === true;
  return false;
}

/** Microsoft users are identified by tenant id + object id, never by email (D50). */
export function microsoftAccountId(profile: Record<string, unknown>): string {
  const { tid, oid } = profile;
  if (typeof tid !== 'string' || !tid || typeof oid !== 'string' || !oid) throw new Error('microsoft profile without tid/oid');
  return `${tid}:${oid}`;
}

// Better Auth's Microsoft provider keys accounts by `oid` alone, which is only unique within a
// tenant. The provider object is built internally, so it is patched once at init.
const microsoftSubject = {
  id: 'worca-microsoft-subject',
  init(ctx) {
    const provider = ctx.socialProviders.find((p) => p.id === 'microsoft');
    if (provider) provider.accountSubject = ({ profile }) => microsoftAccountId(profile as Record<string, unknown>);
  },
} satisfies BetterAuthPlugin;

// ---- Session method (D23, D24) ------------------------------------------------------------

/** Which sign-in method the endpoint creating a session stands for. */
export function sessionMethodFor(ctx: { path?: string; params?: unknown; body?: unknown } | null | undefined): SessionInfo['method'] {
  const path = ctx?.path ?? '';
  if (path.startsWith('/passkey/')) return 'passkey';
  if (path.startsWith('/sso/') || path === '/sign-in/sso') return 'sso';
  let provider: unknown;
  if (path.startsWith('/callback')) provider = (ctx?.params as { id?: string } | undefined)?.id ?? path.split('/')[2];
  else if (path === '/sign-in/social') provider = (ctx?.body as { provider?: string } | undefined)?.provider;
  if (provider === 'google' || provider === 'microsoft') return provider;
  // Anything else counts as the weakest method, so a policy never over-trusts a session.
  return 'email-otp';
}

// Every passkey change: otherwise deleting the existing ones from an email-code session would
// reopen the first-passkey exception. Losing every passkey means an account reset by support.
const PASSKEY_MUTATION_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

async function passkeyCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** The org owning the domain-verified SSO provider this sign-in came through, if any. */
async function ssoSessionOrg(env: Env, ctx: HookCtx | null | undefined): Promise<string | null> {
  const c = ctx as { params?: { providerId?: string }; body?: { providerId?: string } } | null | undefined;
  const providerId = c?.params?.providerId ?? c?.body?.providerId;
  if (!providerId) return null;
  const row = await env.DB.prepare('SELECT organizationId FROM ssoProvider WHERE providerId = ? AND domainVerified = 1')
    .bind(providerId)
    .first<{ organizationId: string | null }>();
  return row?.organizationId ?? null;
}

// ---- Passkey "last used" (ui-feasibility.md T14) ------------------------------------------

/** What the after-hook sees of a /passkey/verify-authentication call. */
export interface PasskeyHookCtx {
  path?: string;
  body?: unknown;
  context?: { returned?: unknown; newSession?: { user?: { id?: string } } | null };
}

/**
 * The credential and user of a successful passkey sign-in, or null for anything else. The
 * plugin finds the passkey by the assertion's credential id (`response.id`) and creates the
 * session for that passkey's owner, so the pair identifies exactly the passkey that was used.
 */
export function passkeyUseFrom(ctx: PasskeyHookCtx | null | undefined): { credentialId: string; userId: string } | null {
  if (ctx?.path !== '/passkey/verify-authentication') return null;
  const returned = ctx.context?.returned;
  if (!returned || returned instanceof Error || (returned instanceof Response && !returned.ok)) return null;
  const userId = ctx.context?.newSession?.user?.id ?? (returned as { user?: { id?: unknown } }).user?.id;
  const credentialId = (ctx.body as { response?: { id?: unknown } } | undefined)?.response?.id;
  if (typeof userId !== 'string' || !userId || typeof credentialId !== 'string' || !credentialId) return null;
  return { credentialId, userId };
}

/** Sets passkey.lastUsedAt (0007_account.sql); scoped to the owner so a credential id alone can't touch another account's row. */
export async function recordPasskeyUse(env: Env, used: { credentialId: string; userId: string }, at = new Date()): Promise<void> {
  try {
    await env.DB.prepare('UPDATE passkey SET lastUsedAt = ? WHERE credentialID = ? AND userId = ?')
      .bind(at.toISOString(), used.credentialId, used.userId)
      .run();
  } catch (err) {
    // A display field: never fail a sign-in over it.
    console.error(JSON.stringify({ at: 'passkey_last_used', error: String(err) }));
  }
}

// ---- Blind index for verification identifiers (D54) ---------------------------------------

/** Better Auth puts the email address in verification identifiers; store only its HMAC. */
export const identifierHash = (env: Env, identifier: string) => getKeyRing(env).blindIndex(identifier);

// ---- Options ------------------------------------------------------------------------------

type HookCtx = {
  path?: string;
  params?: unknown;
  body?: unknown;
  headers?: Headers | null;
  request?: Request;
  context?: { adapter: MinimalAdapter };
} | null | undefined;

interface MinimalAdapter {
  findMany<T>(args: { model: string; where?: { field: string; value: unknown; operator?: 'eq' }[] }): Promise<T[]>;
  findOne<T>(args: { model: string; where: { field: string; value: unknown }[] }): Promise<T | null>;
}

const headersOf = (ctx: HookCtx) => ctx?.headers ?? ctx?.request?.headers ?? null;

async function adapterFor(env: Env, ctx: HookCtx): Promise<MinimalAdapter> {
  if (ctx?.context?.adapter) return ctx.context.adapter;
  return (await getAuth(env).$context).adapter as unknown as MinimalAdapter;
}

async function hasPendingInvitation(adapter: MinimalAdapter, email: string): Promise<boolean> {
  const rows = await adapter.findMany<{ expiresAt: Date | string | number }>({
    model: 'invitation',
    where: [
      { field: 'email', value: email.toLowerCase() },
      { field: 'status', value: 'pending' },
    ],
  });
  return rows.some((r) => new Date(r.expiresAt).getTime() > Date.now());
}

/** The org SSO provider of an SSO callback creating a user, or null for any other path. */
async function ssoProviderFacts(env: Env, ctx: HookCtx): Promise<SsoProviderFacts | null> {
  const providerId = (ctx?.params as { providerId?: unknown } | undefined)?.providerId;
  if (!ctx?.path?.startsWith('/sso/') || typeof providerId !== 'string') return null;
  const adapter = await adapterFor(env, ctx);
  const provider = await adapter.findOne<{ organizationId?: string | null; domain: string; domainVerified?: boolean | number | null }>({
    model: 'ssoProvider',
    where: [{ field: 'providerId', value: providerId }],
  });
  if (!provider) return null;
  const organizationId = provider.organizationId ?? null;
  return {
    organizationId,
    domain: provider.domain,
    domainVerified: provider.domainVerified === true || provider.domainVerified === 1,
    orgActive: organizationId ? await isOrgActive(env, adapter, organizationId) : false,
  };
}

async function isOrgActive(env: Env, adapter: MinimalAdapter, orgId: string): Promise<boolean> {
  const org = await adapter.findOne({ model: 'organization', where: [{ field: 'id', value: orgId }] });
  if (!org) return false;
  try {
    const row = await env.DB.prepare('SELECT status FROM org_settings WHERE org_id = ?').bind(orgId).first<{ status: string }>();
    return !row || row.status === 'active';
  } catch {
    return true; // org_settings (0003_platform.sql) not migrated: existence is all we can check
  }
}

function loopbackOrigins(env: Env): string[] {
  // wrangler dev serves app.localhost:<port> and rewrites Origin. Local only.
  return env.LOCAL_DEV === '1' ? ['http://*.localhost:*', 'http://localhost:*', 'http://127.0.0.1:*'] : [];
}

function socialProviders(env: Env): BetterAuthOptions['socialProviders'] {
  return {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            mapProfileToUser: (profile: object) => ({ emailVerified: emailVouched('google', profile as Record<string, unknown>) }),
          },
        }
      : {}),
    ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            tenantId: 'common',
            disableProfilePhoto: true, // no Graph call; we request only openid/profile/email (D22)
            mapProfileToUser: (profile: object) => ({ emailVerified: emailVouched('microsoft', profile as Record<string, unknown>) }),
          },
        }
      : {}),
  };
}

/** Options without the instance, so scripts/auth-schema.ts can generate the schema from them. */
export function buildAuthOptions(env: Env, database: BetterAuthOptions['database']) {
  const origin = new URL(env.APP_ORIGIN).origin;
  return {
    appName: 'Worca',
    database,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: origin,
    basePath: '/api/auth',
    // Our own origin only. This list also decides which callbackURL/redirect targets and request
    // origins Better Auth accepts, so tenant IdP origins never go here: SSO registration trusts the
    // IdP of the provider being registered through a predicate of its own (tenancy/sso-routes.ts).
    trustedOrigins: [origin, ...loopbackOrigins(env)],
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      additionalFields: {
        method: { type: 'string', required: false, input: false },
        mfa: { type: 'boolean', required: false, defaultValue: false, input: false },
        ssoOrgId: { type: 'string', required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        // Fail-safe default; the create hook always sets it (D25).
        status: { type: 'string', required: false, defaultValue: 'pending', input: false },
        registeredVia: { type: 'string', required: false, input: false },
        signupTier: { type: 'string', required: false, input: false, returned: false },
        // registration_codes.code_hash of the code claimed at sign-up (0009_support.sql, P8).
        registrationCodeId: { type: 'string', required: false, input: false, returned: false },
      },
    },
    verification: { storeIdentifier: { hash: (identifier: string) => identifierHash(env, identifier) } },
    account: {
      // An email code always signs a user in, so unlinking their only Google or Microsoft account
      // can't lock them out (Better Auth refuses it by default, assuming a password account).
      accountLinking: { enabled: true, trustedProviders: [] as string[], allowDifferentEmails: false, allowUnlinkingAll: true },
    },
    socialProviders: socialProviders(env),
    advanced: {
      useSecureCookies: env.LOCAL_DEV !== '1',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    hooks: {
      // SSO providers are created only by the tenancy SSO endpoint for a tenant admin, which
      // calls auth.api.registerSSOProvider server-side (no request). The public route is closed.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sso/register' && ctx.request) {
          throw new APIError('FORBIDDEN', { code: 'sso_register_internal_only', message: 'Register SSO providers through the organization settings.' });
        }
        // D24: a passkey is the second factor, so an email-code session must not be able to add,
        // change or remove passkeys of an account that has one. The first can come from any session.
        if (ctx.request && PASSKEY_MUTATION_PATHS.has(ctx.path)) {
          const current = await getSessionFromCtx(ctx);
          if (current && !(current.session as { mfa?: boolean }).mfa && (await passkeyCount(env, current.user.id)) > 0) {
            throw new APIError('FORBIDDEN', { code: 'mfa_required', message: 'Sign in with an existing passkey to add another one.' });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // T14: remember when a passkey last signed someone in.
        const used = passkeyUseFrom(ctx as unknown as PasskeyHookCtx);
        if (used) await recordPasskeyUse(env, used);
        if (ctx.path !== '/passkey/verify-registration' || !ctx.context.returned || ctx.context.returned instanceof Error) return;
        const current = await getSessionFromCtx(ctx);
        if (!current) return;
        await auditPlatform(env, {
          actorId: current.user.id,
          actorRole: 'user',
          action: 'auth.passkey_added',
          targetType: 'user',
          targetId: current.user.id,
          details: { mfaSession: (current.session as { mfa?: boolean }).mfa === true },
        });
        await sendEmail(env, { to: current.user.email, ...passkeyAddedEmail(siteOf(env)) });
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, endpointCtx) => {
            const ctx = endpointCtx as unknown as HookCtx;
            try {
              // IdP claims about email verification count for nothing on the SSO path: only an
              // org-owned provider whose verified domain is the email's domain vouches.
              const sso = await ssoProviderFacts(env, ctx);
              const emailVerified = ctx?.path?.startsWith('/sso/') ? !!sso && ssoVouches(sso, user.email) : user.emailVerified === true;
              const decision = await decideRegistration(env, {
                email: user.email,
                emailVerified,
                sso,
                code: signupCodeFrom({ headers: headersOf(ctx), body: ctx?.body }),
                hasPendingInvitation: async () => hasPendingInvitation(await adapterFor(env, ctx), user.email),
              });
              return { data: { ...user, emailVerified, ...decision } };
            } catch (err) {
              if (err instanceof RegistrationError) throw new APIError('FORBIDDEN', { code: err.code, message: err.message });
              throw err;
            }
          },
          // D69: a code from a granted access request marks that request joined. Read back from
          // the row: registrationCodeId is returned: false. Never fails the sign-up.
          after: async (user) => {
            try {
              const row = await env.DB.prepare('SELECT registrationCodeId FROM user WHERE id = ?').bind(user.id).first<{ registrationCodeId: string | null }>();
              if (row?.registrationCodeId) await (await import('../public/access-requests')).markAccessRequestJoined(env, row.registrationCodeId);
            } catch (err) {
              // No details: the message could name the new account's address.
              console.error(JSON.stringify({ at: 'access_request.mark_joined_failed' }));
            }
          },
        },
      },
      session: {
        create: {
          before: async (session, endpointCtx) => {
            const ctx = endpointCtx as unknown as HookCtx;
            const adapter = await adapterFor(env, ctx);
            const user = await adapter.findOne<{ status?: string }>({ model: 'user', where: [{ field: 'id', value: session.userId }] });
            if (user?.status === 'disabled') throw new APIError('FORBIDDEN', { code: 'account_disabled', message: 'This account is disabled.' });
            const method = sessionMethodFor(ctx);
            // An org's "SSO only" policy means its own provider, so remember whose SSO this was.
            // Null means no domain-verified org provider: such a session satisfies no SSO policy.
            const ssoOrgId = method === 'sso' ? await ssoSessionOrg(env, ctx) : null;
            return { data: { ...session, method, mfa: method === 'passkey', ssoOrgId } };
          },
          after: async (session) => {
            await auditPlatform(env, {
              actorId: session.userId,
              actorRole: 'user',
              action: 'auth.signed_in',
              targetType: 'user',
              targetId: session.userId,
              details: { method: String((session as { method?: string }).method ?? 'unknown') },
            });
          },
        },
        // Sign-out and revocation end the person's instance sessions too (D46).
        delete: {
          after: async (session) => {
            await dropGateSessionsForUser(env, session.userId, { cpSessionId: session.id });
          },
        },
      },
    },
    plugins: [
      emailOTP({
        storeOTP: 'hashed',
        expiresIn: 300,
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email, otp }) => {
          await sendEmail(env, { to: email, ...signInCodeEmail(otp, siteOf(env)) });
        },
      }),
      passkey({ rpID: new URL(origin).hostname, rpName: 'Worca', origin }),
      organization({
        ac,
        roles: tenantRoles,
        creatorRole: 'tenant_admin',
        // Accepting by invitation id also needs the session's email to be verified.
        requireEmailVerificationOnInvitation: true,
        // 7 days, as GitHub and Slack do; Better Auth's default of 48 hours made every new
        // invitation look "expiring soon" in the org overview.
        invitationExpiresIn: 7 * 24 * 60 * 60,
        teams: { enabled: true, defaultTeam: { enabled: false }, allowRemovingAllTeams: true },
        allowUserToCreateOrganization: (user) => canCreateOrganization(env, user),
        sendInvitationEmail: async (data) => {
          const mail = orgInvitationEmail({
            orgName: data.organization.name,
            inviterName: data.inviter.user.name,
            invitationId: data.id,
            site: siteOf(env),
          });
          await sendEmail(env, { to: data.email, ...mail });
        },
      }),
      // Registration goes through tenancy (POST /api/orgs/:orgId/sso), which runs OIDC discovery
      // itself and passes skipDiscovery with every endpoint, so nothing here trusts IdP origins.
      sso({
        domainVerification: { enabled: true },
        // People an org's SSO brings in join it as tenant users; the plugin's default role,
        // "member", is not one of ours (tenantRoles).
        organizationProvisioning: { getRole: async () => 'tenant_user' as 'member' },
      }),
      microsoftSubject,
    ],
  } satisfies BetterAuthOptions;
}

function createAuth(env: Env) {
  return betterAuth(buildAuthOptions(env, createDatabase(env)));
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * A platform admin's waitlist approval (the tenancy approval endpoint calls this): the account
 * becomes active and may create an org. Returns false unless the user was pending.
 */
export async function approveWaitlistedUser(env: Env, userId: string): Promise<boolean> {
  const ctx = await getAuth(env).$context;
  const user = (await ctx.internalAdapter.findUserById(userId)) as { status?: string } | null;
  if (user?.status !== 'pending') return false;
  await ctx.internalAdapter.updateUser(userId, { status: 'active', registeredVia: 'approved' });
  return true;
}

/**
 * One Better Auth instance per request (cached in the request's store, see withRequestScope), never
 * shared across requests: an instance built during one request holds promises tied to that
 * request, and another request awaiting them hangs in workerd when the first ends or is canceled
 * (seen on prod as sign-ins stuck for 15 s right after the rate-limit check). Outside a request
 * scope (crons, Workflows) every call builds its own.
 */
export function getAuth(env: Env): Auth {
  const store = requestScope.getStore();
  let auth = store?.get(env);
  if (!auth) {
    auth = createAuth(env);
    store?.set(env, auth);
  }
  return auth;
}

const requestScope = new AsyncLocalStorage<WeakMap<Env, Auth>>();

/** Runs one request's handling with its own Better Auth cache. */
export function withRequestScope<T>(fn: () => T): T {
  return requestScope.run(new WeakMap(), fn);
}

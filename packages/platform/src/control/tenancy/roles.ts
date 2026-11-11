// Platform roles and capabilities (D13, D14, D15, D24), tenant role guards (D18).
// No inheritance, so superadmin is listed on every admin
// capability explicitly. No capability here ever grants access to a tenant instance (D15).
import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../env';
import { fail, memberRole, type TenantRole } from './util';

export const PLATFORM_ROLES = ['support', 'admin', 'superadmin'] as const; // increasing capability
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type Capability =
  | 'platform.view' // orgs, instances and their status (ids, counts, versions; no tenant names)
  | 'audit.view' // platform audit log
  | 'tenants.manage' // org tier and limits
  | 'registration.codes' // create, list, revoke registration codes (tenant invites)
  | 'waitlist.manage' // approve or reject pending accounts
  | 'instances.stop' // stop an instance for abuse and lift it (D16, D47)
  | 'instances.rotate' // renew instances' credentials, one or all (D74)
  | 'system.settings' // registration mode and other platform settings (D25)
  | 'users.support' // find a user by exact email; sign out, disable, two-person sign-in reset (P8)
  | 'roles.manage' // grant and revoke platform roles
  | 'access_requests.manage' // read, grant and decline access requests from the website (D69)
  | 'keys.master' // master-key rotation (D37)
  | 'newsletter.view'; // newsletter subscriber counts and sent issues (D70)

export const CAPABILITIES: Record<Capability, readonly PlatformRole[]> = {
  'platform.view': ['support', 'admin', 'superadmin'],
  'audit.view': ['admin', 'superadmin'],
  'tenants.manage': ['admin', 'superadmin'],
  'registration.codes': ['admin', 'superadmin'],
  'waitlist.manage': ['admin', 'superadmin'],
  'instances.stop': ['admin', 'superadmin'],
  'instances.rotate': ['admin', 'superadmin'],
  'system.settings': ['superadmin'],
  'users.support': ['admin', 'superadmin'],
  'roles.manage': ['superadmin'],
  'access_requests.manage': ['superadmin'],
  'keys.master': ['superadmin'],
  'newsletter.view': ['admin', 'superadmin'],
};

export function can(roles: readonly PlatformRole[], cap: Capability): boolean {
  return roles.some((r) => CAPABILITIES[cap].includes(r));
}

export function strongestRole(roles: readonly PlatformRole[]): PlatformRole | null {
  return PLATFORM_ROLES.filter((r) => roles.includes(r)).at(-1) ?? null;
}

export async function getPlatformRoles(env: Env, userId: string): Promise<PlatformRole[]> {
  const rows = await env.DB.prepare('SELECT role FROM platform_roles WHERE user_id = ?').bind(userId).all<{ role: string }>();
  const held = new Set(rows.results.map((r) => r.role));
  return PLATFORM_ROLES.filter((r) => held.has(r));
}

export async function countSuperadmins(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_roles WHERE role = 'superadmin'").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countTenantAdmins(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM member WHERE organizationId = ? AND role = 'tenant_admin'")
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Orgs where this user is the only tenant admin (D18, D59). */
export async function soleAdminOrgIds(env: Env, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT m.organizationId AS orgId FROM member m
     WHERE m.userId = ? AND m.role = 'tenant_admin'
       AND (SELECT COUNT(*) FROM member x WHERE x.organizationId = m.organizationId AND x.role = 'tenant_admin') = 1`,
  )
    .bind(userId)
    .all<{ orgId: string }>();
  return rows.results.map((r) => r.orgId);
}

/** 401 without a session; 403 when the account isn't active (pending or disabled). */
export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || !c.get('session')) fail(401, 'unauthenticated');
  if (user.status !== 'active') fail(403, 'account_not_active');
  await next();
};

/** Signed in at all, any status (profile, export, deletion). */
export const requireSignedIn: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get('user') || !c.get('session')) fail(401, 'unauthenticated');
  await next();
};

/** 401 / 403; every platform capability also needs an MFA session (D24). */
export function requireCap(cap: Capability): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get('user');
    const session = c.get('session');
    if (!user || !session) fail(401, 'unauthenticated');
    if (user.status !== 'active') fail(403, 'forbidden');
    const roles = await getPlatformRoles(c.env, user.id);
    if (!can(roles, cap)) fail(403, 'forbidden');
    if (!session.mfa) fail(403, 'mfa_required');
    await next();
  };
}

/**
 * Guards routes with `:orgId`. Non-members get 404 so org ids can't be probed; members without
 * the required role get 403. Platform roles grant nothing here (D15).
 */
export function requireOrgRole(role: TenantRole | 'any' = 'any'): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !c.get('session')) fail(401, 'unauthenticated');
    if (user.status !== 'active') fail(403, 'account_not_active');
    const orgId = c.req.param('orgId');
    if (!orgId) fail(404, 'not_found');
    const held = await memberRole(c.env, orgId, user.id);
    if (!held) fail(404, 'not_found');
    if (role === 'tenant_admin' && held !== 'tenant_admin') fail(403, 'forbidden');
    await next();
  };
}

/** D24: tenant admins confirm destructive actions, and rotate keys, with MFA or a passkey. */
export const requireMfa: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get('session')?.mfa) fail(403, 'mfa_required');
  await next();
};

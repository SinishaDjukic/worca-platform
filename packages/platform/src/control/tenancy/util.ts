// Small helpers shared by the tenancy routes: errors, validation, random values, encrypted
// field contexts (docs/internal-apis.md "Field contexts") and org/member lookups.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type { AppContext, Env, SessionInfo, SessionUser } from '../env';
import { gate } from '../gate-client';
import type { FieldContext, KeyOwner } from '../keys-api';
import { deps } from './deps';

export type TenantRole = 'tenant_admin' | 'tenant_user';
export const TENANT_ROLES: readonly TenantRole[] = ['tenant_admin', 'tenant_user'];
export const LOGIN_METHODS = ['email-otp', 'passkey', 'google', 'microsoft', 'sso'] as const;
export type LoginMethod = SessionInfo['method'];

export function fail(status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 502, message: string): never {
  throw new HTTPException(status, { message });
}

export async function parseBody<S extends z.ZodType>(c: Context<AppContext>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'invalid_json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(400, 'invalid_body');
  return parsed.data;
}

/** The signed-in user and session; requireUser/requireCap/requireOrgRole ran before. */
export function actor(c: Context<AppContext>): { user: SessionUser; session: SessionInfo } {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) fail(401, 'unauthenticated');
  return { user, session };
}

// D8: base32 without look-alike characters (no 0/o, 1/l/i).
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomSlug(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const isoNow = (): string => new Date().toISOString();

export function field(table: string, column: string, rowId: string, owner: KeyOwner): FieldContext {
  return { table, column, rowId, owner };
}
export const orgOwner = (id: string): KeyOwner => ({ type: 'org', id });
export const userOwner = (id: string): KeyOwner => ({ type: 'user', id });

/** Decrypts, returning null for a destroyed key or a value that isn't ours. */
export async function tryDecrypt(env: Env, ctx: FieldContext, value: unknown): Promise<string | null> {
  if (typeof value !== 'string') return null;
  const ring = deps().keyRing(env);
  if (!ring.isCiphertext(value)) return value;
  try {
    return await ring.decrypt(ctx, value);
  } catch {
    return null;
  }
}

export async function userProfile(env: Env, userId: string): Promise<{ id: string; email: string | null; name: string | null; status: string } | null> {
  const row = await env.DB.prepare('SELECT id, email, name, status FROM user WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; name: string; status: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    email: await tryDecrypt(env, field('user', 'email', row.id, userOwner(row.id)), row.email),
    name: await tryDecrypt(env, field('user', 'name', row.id, userOwner(row.id)), row.name),
    status: row.status ?? 'active',
  };
}

export async function orgName(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT name FROM organization WHERE id = ?').bind(orgId).first<{ name: string }>();
  if (!row) return null;
  return tryDecrypt(env, field('organization', 'name', orgId, orgOwner(orgId)), row.name);
}

export async function memberRole(env: Env, orgId: string, userId: string): Promise<TenantRole | null> {
  const row = await env.DB.prepare('SELECT role FROM member WHERE organizationId = ? AND userId = ?')
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (!row) return null;
  return row.role === 'tenant_admin' ? 'tenant_admin' : 'tenant_user';
}

export async function tenantAdminIds(env: Env, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT userId FROM member WHERE organizationId = ? AND role = 'tenant_admin'")
    .bind(orgId)
    .all<{ userId: string }>();
  return rows.results.map((r) => r.userId);
}

export async function orgInstanceIds(env: Env, orgId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT id FROM instances WHERE org_id = ?').bind(orgId).all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

export async function teamInstanceIds(env: Env, teamId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT instance_id FROM instance_teams WHERE team_id = ?')
    .bind(teamId)
    .all<{ instance_id: string }>();
  return rows.results.map((r) => r.instance_id);
}

/** D46: access ended, so the gate drops the user's live sessions on each instance. */
export async function dropGateSessions(env: Env, instanceIds: string[], userId: string): Promise<void> {
  for (const id of instanceIds) {
    try {
      await gate(env).dropSessions(id, { userId });
    } catch (err) {
      // Renewal re-checks access within the token lifetime (D45); don't fail the change.
      console.error(JSON.stringify({ at: 'dropGateSessions', instanceId: id, message: (err as Error).message }));
    }
  }
}

/** Emails a list of users; failures are logged, never thrown (notifications follow the change). */
export async function notifyUsers(env: Env, userIds: string[], subject: string, text: string): Promise<void> {
  for (const id of userIds) {
    const profile = await userProfile(env, id);
    if (!profile?.email) continue;
    try {
      await deps().sendEmail(env, { to: profile.email, subject, text });
    } catch (err) {
      console.error(JSON.stringify({ at: 'notifyUsers', userId: id, message: (err as Error).message }));
    }
  }
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@').pop() ?? '';
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Blind index of a normalized domain; prefixed so it never collides with an email index. */
export function domainIndex(env: Env, domain: string): Promise<string> {
  return deps().keyRing(env).blindIndex(`domain:${normalizeDomain(domain)}`);
}

/** ssoProvider.domainIndex as the adapter wrapper computes it (trim + lowercase, no prefix). */
export function ssoDomainIndex(env: Env, domain: string): Promise<string> {
  return deps().keyRing(env).blindIndex(domain.trim().toLowerCase());
}

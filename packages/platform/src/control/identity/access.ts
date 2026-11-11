// OWNER: agent:identity. The checks behind every identity token, at the code exchange and at each
// renewal (D45): live control-plane session, active user, instance behind the host, team access
// and login policy including the session's sign-in method (D23).
import type { Env } from '../env';
import type { FieldContext } from '../keys-api';
import { deps } from './deps';
import { signIdentityToken } from './tokens';

interface SessionRow {
  id: string;
  userId: string;
  method: string;
  ssoOrgId: string | null;
  expiresAtMs: number;
}

/** Better Auth stores dates as ISO strings or numbers depending on the adapter; accept both. */
export function toMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toMs(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export async function loadLiveSession(env: Env, sessionId: string, now = Date.now()): Promise<SessionRow | null> {
  const row = await env.DB.prepare('SELECT id, userId, expiresAt, method, ssoOrgId FROM "session" WHERE id = ?')
    .bind(sessionId)
    .first<{ id: string; userId: string; expiresAt: unknown; method: string | null; ssoOrgId: string | null }>();
  if (!row) return null;
  const expiresAtMs = toMs(row.expiresAt);
  if (expiresAtMs <= now) return null;
  return { id: row.id, userId: row.userId, method: row.method ?? '', ssoOrgId: row.ssoOrgId ?? null, expiresAtMs };
}

async function decryptUserField(env: Env, userId: string, column: 'email' | 'name', value: string): Promise<string> {
  const ring = deps().getKeyRing(env);
  if (!ring.isCiphertext(value)) return value;
  const ctx: FieldContext = { table: 'user', column, rowId: userId, owner: { type: 'user', id: userId } };
  return ring.decrypt(ctx, value);
}

export async function loadActiveUser(env: Env, userId: string): Promise<{ id: string; email: string; name: string } | null> {
  const row = await env.DB.prepare('SELECT id, email, name, status FROM "user" WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; name: string | null; status: string | null }>();
  if (!row || row.status !== 'active') return null;
  return {
    id: row.id,
    email: await decryptUserField(env, row.id, 'email', row.email),
    name: row.name ? await decryptUserField(env, row.id, 'name', row.name) : '',
  };
}

export interface Issued {
  token: string;
  tokenExp: number;
  instanceId: string;
}

/**
 * Null whenever any check fails. `instanceId`, when given (code exchange), must still be the
 * instance behind `host`.
 */
export async function issueForSession(
  env: Env,
  input: { userId: string; sessionId: string; host: string; instanceId?: string },
): Promise<Issued | null> {
  const session = await loadLiveSession(env, input.sessionId);
  if (!session || session.userId !== input.userId) return null;
  const user = await loadActiveUser(env, input.userId);
  if (!user) return null;
  const instance = await deps().findInstanceByHost(env, input.host);
  if (!instance || (input.instanceId && instance.id !== input.instanceId)) return null;
  const access = await deps().checkInstanceAccess(env, { userId: user.id, sessionMethod: session.method, ssoOrgId: session.ssoOrgId, instanceId: instance.id });
  if (!access.ok) return null;
  const { token, exp } = await signIdentityToken(env, {
    aud: input.host,
    sub: user.id,
    email: user.email,
    name: user.name,
    org: access.orgId,
    inst: instance.id,
    teams: access.teamIds,
  });
  return { token, tokenExp: exp, instanceId: instance.id };
}

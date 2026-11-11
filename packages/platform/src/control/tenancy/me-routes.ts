// The signed-in user's own account, mounted at /api/me (D21, D59).
import { Hono } from 'hono';
import { z } from 'zod';
import { SESSION_HANDLE_PREFIX } from '../auth/adapter-wrapper';
import type { AppContext, Env, SessionInfo } from '../env';
import { auditPlatform, readOrgAudit, type AuditAction } from './audit';
import { confirmationSent, registerConfirmAction, startConfirmation } from './confirmations';
import { deps } from './deps';
import { purgeUser } from './lifecycle';
import { countSuperadmins, getPlatformRoles, requireSignedIn, soleAdminOrgIds } from './roles';
import { actor, fail, field, isoNow, orgName, parseBody, userOwner, userProfile } from './util';
import { meNewsletterApp } from '../newsletter/routes';

export const meApp = new Hono<AppContext>();

meApp.route('/newsletter', meNewsletterApp); // D70: the account page's newsletter card

async function memberships(env: Env, userId: string, opts: { instanceCounts?: boolean } = {}) {
  const rows = await env.DB.prepare('SELECT organizationId AS orgId, role, createdAt FROM member WHERE userId = ? ORDER BY createdAt')
    .bind(userId)
    .all<{ orgId: string; role: string; createdAt: string }>();
  const out = [];
  for (const r of rows.results) {
    const org: { id: string; name: string | null; role: string; joinedAt: string; instances?: number } = {
      id: r.orgId,
      name: await orgName(env, r.orgId),
      role: r.role,
      joinedAt: r.createdAt,
    };
    if (opts.instanceCounts) org.instances = await usableInstanceCount(env, r.orgId, userId, r.role);
    out.push(org);
  }
  return out;
}

/**
 * T3: how many of an org's instances the caller can open, the same rows the instances list shows
 * them (instances/routes.ts visibleRows, D19): tenant admins all, tenant users those granted to
 * one of their teams of that org. Only a number, so nothing else about the org leaks.
 */
async function usableInstanceCount(env: Env, orgId: string, userId: string, role: string): Promise<number> {
  const isAdmin = role.split(',').map((x) => x.trim()).includes('tenant_admin');
  const row = isAdmin
    ? await env.DB.prepare(`SELECT COUNT(*) AS n FROM instances WHERE org_id = ? AND status <> 'deleting'`).bind(orgId).first<{ n: number }>()
    : await env.DB.prepare(
        `SELECT COUNT(DISTINCT i.id) AS n FROM instances i
           JOIN instance_teams it ON it.instance_id = i.id
           JOIN team t ON t.id = it.team_id AND t.organizationId = i.org_id
           JOIN teamMember tm ON tm.teamId = it.team_id AND tm.userId = ?
          WHERE i.org_id = ? AND i.status <> 'deleting'`,
      )
        .bind(userId, orgId)
        .first<{ n: number }>();
  return row?.n ?? 0;
}

/** T9/T14 "Signs in with": an email code always works; passkeys and linked providers on top. */
async function signInMethods(env: Env, userId: string) {
  const [pk, acc] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?').bind(userId),
    env.DB.prepare('SELECT DISTINCT providerId FROM account WHERE userId = ?').bind(userId),
  ]);
  const providers = new Set<'google' | 'microsoft' | 'sso'>();
  for (const { providerId } of (acc?.results ?? []) as { providerId: string }[]) {
    if (providerId === 'credential') continue; // Better Auth's email-code/password row, not a provider
    providers.add(providerId === 'google' || providerId === 'microsoft' ? providerId : 'sso'); // anything else is an org SSO provider id
  }
  return {
    emailCode: true,
    passkeys: ((pk?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0,
    providers: [...providers].sort(),
    available: availableProviders(env),
  };
}

/** The social providers this deployment has credentials for, i.e. the ones a user can link. */
export function availableProviders(env: Env): ('google' | 'microsoft')[] {
  const out: ('google' | 'microsoft')[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push('google');
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) out.push('microsoft');
  return out;
}

meApp.get('/', requireSignedIn, async (c) => {
  const { user, session } = actor(c);
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, status: user.status },
    session: { method: session.method, mfa: session.mfa, activeOrganizationId: session.activeOrganizationId },
    signIn: await signInMethods(c.env, user.id),
    orgs: await memberships(c.env, user.id, { instanceCounts: true }),
    platformRoles: await getPlatformRoles(c.env, user.id),
  });
});

meApp.patch('/', requireSignedIn, async (c) => {
  const { user } = actor(c);
  const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1).max(100) }));
  const enc = await deps().keyRing(c.env).encrypt(field('user', 'name', user.id, userOwner(user.id)), name);
  await c.env.DB.prepare('UPDATE user SET name = ?, updatedAt = ? WHERE id = ?').bind(enc, isoNow(), user.id).run();
  await auditPlatform(c.env, { actorId: user.id, actorRole: 'user', action: 'user.renamed', targetType: 'user', targetId: user.id });
  return c.json({ ok: true });
});

/** D59: profile, memberships, teams, and this user's entries in the logs still kept (D57). */
meApp.get('/export', requireSignedIn, async (c) => {
  const { user } = actor(c);
  const profile = await userProfile(c.env, user.id);
  const orgs = await memberships(c.env, user.id);
  const teams = await c.env.DB.prepare(
    'SELECT t.id, t.organizationId AS orgId FROM teamMember tm JOIN team t ON t.id = tm.teamId WHERE tm.userId = ?',
  )
    .bind(user.id)
    .all<{ id: string; orgId: string }>();
  const platformLog = await c.env.DB.prepare(
    'SELECT id, at, actor_role, action, target_type, target_id, details FROM audit_platform WHERE actor_id = ? OR (target_type = ? AND target_id = ?) ORDER BY at DESC',
  )
    .bind(user.id, 'user', user.id)
    .all();
  const orgLog = [];
  for (const o of orgs) orgLog.push({ orgId: o.id, entries: await readOrgAudit(c.env, o.id, { actorId: user.id, limit: 500 }) });
  await auditPlatform(c.env, { actorId: user.id, actorRole: 'user', action: 'user.exported', targetType: 'user', targetId: user.id });
  c.header('Content-Disposition', 'attachment; filename="worca-account-export.json"');
  return c.json({
    exportedAt: new Date().toISOString(),
    profile,
    platformRoles: await getPlatformRoles(c.env, user.id),
    orgs,
    teams: teams.results,
    audit: { platform: platformLog.results, orgs: orgLog },
  });
});

/** D59: refused while the last tenant admin of an org; otherwise confirmed by emailed link (D30). */
meApp.delete('/', requireSignedIn, async (c) => {
  const { user } = actor(c);
  const { confirmName } = await parseBody(c, z.object({ confirmName: z.string() }));
  const profile = await userProfile(c.env, user.id);
  if (!profile?.email || confirmName.trim().toLowerCase() !== profile.email.toLowerCase()) fail(422, 'confirm_name_mismatch');
  await assertDeletable(c.env, user.id);
  const started = await startConfirmation(c.env, {
    userId: user.id,
    orgId: null,
    action: 'account.delete',
    target: user.id,
    summary: `Delete the Worca account ${profile.email}. Your memberships and profile are deleted immediately and permanently.`,
  });
  return confirmationSent(c, started);
});

async function assertDeletable(env: Env, userId: string): Promise<void> {
  const sole = await soleAdminOrgIds(env, userId);
  if (sole.length > 0) fail(409, 'last_tenant_admin');
  const roles = await getPlatformRoles(env, userId);
  if (roles.includes('superadmin') && (await countSuperadmins(env)) <= 1) fail(409, 'last_superadmin');
}

registerConfirmAction(
  'account.delete',
  async (env, _ctx, { userId }) => {
    await assertDeletable(env, userId); // state may have changed in the 30 minutes
    await purgeUser(env, userId, { id: userId, role: 'user' });
  },
  { label: 'Delete your account', mfa: false },
);

// ---- Sessions (T14) ---------------------------------------------------------------------------
// Better Auth's /list-sessions, /revoke-session and /revoke-other-sessions stay closed
// (auth/routes.ts). These go through its internal adapter, so the adapter wrapper hands out
// signed session handles instead of tokens (security.md "The Better Auth adapter", D49) and
// every deletion runs the session.delete.after hook, which drops the session's gate sessions on
// the user's instances (D46).

// Better Auth is imported lazily, as in deps.ts: auth/index imports tenancy modules.
const betterAuthContext = async (env: Env) => (await import('../auth/index')).getAuth(env).$context;

/** r1.<sessionId>.<expiresAtSeconds>.<hex hmac>; anything else is refused before any lookup. */
const HANDLE_RE = new RegExp(`^${SESSION_HANDLE_PREFIX.replace('.', '\\.')}[A-Za-z0-9_-]{1,64}\\.\\d{1,12}\\.[0-9a-f]{64}$`);

// Not in audit.ts's AuditAction union yet (owned by tenancy); see the report.
const SESSION_REVOKED: AuditAction = 'auth.session_revoked';
const SESSIONS_REVOKED: AuditAction = 'auth.other_sessions_revoked';

interface SessionRow {
  id: string;
  token: string; // a signed handle: rows listed by user id never carry a raw token
  userId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
  userAgent?: string | null; // decrypted by the adapter wrapper
  method?: string | null;
  mfa?: boolean | number | null;
}

const iso = (v: Date | string | number) => new Date(v).toISOString();

/**
 * A coarse "Browser on OS" label. The raw user agent stays encrypted (D49) and is never
 * returned; no IP address or location either.
 */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser =
    /\bEdg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /\b(OPR|Opera)\//.test(ua) ? 'Opera'
    : /\bSamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /\b(Firefox|FxiOS)\//.test(ua) ? 'Firefox'
    : /\b(Chrome|CriOS|Chromium)\//.test(ua) ? 'Chrome'
    : /\bVersion\/[\d.]+.*\bSafari\//.test(ua) || /\b(iPhone|iPad)\b.*AppleWebKit/.test(ua) ? 'Safari'
    : null;
  const os =
    /\biPad\b/.test(ua) ? 'iPadOS'
    : /\b(iPhone|iPod)\b/.test(ua) ? 'iOS'
    : /\bAndroid\b/.test(ua) ? 'Android'
    : /\bCrOS\b/.test(ua) ? 'ChromeOS'
    : /\bWindows\b/.test(ua) ? 'Windows'
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macOS'
    : /\bLinux\b/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `Browser on ${os}` : 'Unknown device');
}

async function listOwnSessions(env: Env, userId: string, onlyActive: boolean): Promise<SessionRow[]> {
  const ctx = await betterAuthContext(env);
  const rows = (await ctx.internalAdapter.listSessions(userId, { onlyActiveSessions: onlyActive })) as unknown as SessionRow[];
  // The adapter already filtered by user id; checked again because the result is handed to the caller.
  return rows.filter((s) => s.userId === userId && (!onlyActive || new Date(s.expiresAt).getTime() > Date.now()));
}

function sessionView(s: SessionRow, current: SessionInfo) {
  return {
    handle: s.token,
    current: s.id === current.id,
    method: (s.method ?? 'email-otp') as SessionInfo['method'],
    mfa: s.mfa === true || s.mfa === 1,
    device: deviceLabel(s.userAgent),
    createdAt: iso(s.createdAt),
    lastActiveAt: iso(s.updatedAt), // Better Auth refreshes it at most once a day (updateAge)
    expiresAt: iso(s.expiresAt),
  };
}

meApp.get('/sessions', requireSignedIn, async (c) => {
  const { user, session } = actor(c);
  const rows = await listOwnSessions(c.env, user.id, true);
  const sessions = rows.map((s) => sessionView(s, session));
  sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt));
  return c.json({ sessions });
});

meApp.delete('/sessions/:handle', requireSignedIn, async (c) => {
  const { user, session } = actor(c);
  const handle = c.req.param('handle');
  // One answer for malformed, forged, expired and foreign handles: nothing to tell apart.
  if (!HANDLE_RE.test(handle)) fail(404, 'session_not_found');
  const ctx = await betterAuthContext(c.env);
  // The wrapper resolves only a handle whose HMAC and expiry check out; any other value is
  // hashed like a token and matches nothing.
  const found = await ctx.internalAdapter.findSession(handle);
  if (!found || found.session.userId !== user.id) fail(404, 'session_not_found');
  if (found.session.id === session.id) fail(409, 'current_session'); // sign out instead
  await ctx.internalAdapter.deleteSession(handle);
  await auditPlatform(c.env, {
    actorId: user.id,
    actorRole: 'user',
    action: SESSION_REVOKED,
    targetType: 'user',
    targetId: user.id,
    details: { sessionId: found.session.id },
  });
  return c.json({ ok: true });
});

meApp.post('/sessions/revoke-others', requireSignedIn, async (c) => {
  const { user, session } = actor(c);
  const ctx = await betterAuthContext(c.env);
  // Expired rows too: they still name gate sessions the hook should drop.
  const others = (await listOwnSessions(c.env, user.id, false)).filter((s) => s.id !== session.id);
  for (const s of others) await ctx.internalAdapter.deleteSession(s.token);
  await auditPlatform(c.env, {
    actorId: user.id,
    actorRole: 'user',
    action: SESSIONS_REVOKED,
    targetType: 'user',
    targetId: user.id,
    details: { count: others.length },
  });
  return c.json({ ok: true, revoked: others.length });
});

// ---- Passkeys (T14) ---------------------------------------------------------------------------
// Read-only; adding, renaming and removing stay on Better Auth's passkey routes (MFA-guarded, D24).

meApp.get('/passkeys', requireSignedIn, async (c) => {
  const { user } = actor(c);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, deviceType, backedUp, createdAt, lastUsedAt FROM passkey WHERE userId = ? ORDER BY createdAt',
  )
    .bind(user.id)
    .all<{ id: string; name: string | null; deviceType: string; backedUp: number; createdAt: string | null; lastUsedAt: string | null }>();
  return c.json({
    passkeys: results.map((p) => ({
      id: p.id,
      name: p.name,
      deviceType: p.deviceType,
      backedUp: p.backedUp === 1,
      createdAt: p.createdAt ? iso(p.createdAt) : null,
      lastUsedAt: p.lastUsedAt ? iso(p.lastUsedAt) : null,
    })),
  });
});

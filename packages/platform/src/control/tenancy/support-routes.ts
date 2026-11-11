// Platform support (ui-feasibility.md P8), mounted inside the platform console at /api/platform:
// find one user by exact email, sign them out everywhere, disable and enable them, and the
// two-person sign-in reset for someone who lost every passkey (security.md "Passkeys and MFA").
//
// - Lookup is by exact address through the email blind index only; there is no listing and no
//   partial match (security.md "Looking things up by email"). Every lookup is audited.
// - Disabling ends every control-plane session and drops the user's gate sessions at once (D46);
//   the status alone is only checked when a session is created or an identity token renewed.
// - A reset is requested by one staff member and approved, within 24 hours, by a different one
//   signed in with a passkey; approving executes it. Neither may be the user being reset.
// - Staff act only on someone whose strongest platform role ranks strictly below their own: an
//   admin can't sign out, disable, enable or reset another admin or a superadmin, and a
//   superadmin can't act on another superadmin. A reset approval re-checks both the approver and
//   the requester against the target. Re-enabling needs at least the rank of whoever disabled
//   the account (user.disabledBy / disabledByRole, migration 0015).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { dropGateSessionsForUser } from '../gate-client';
import { auditPlatform } from './audit';
import { deps } from './deps';
import { can, getPlatformRoles, PLATFORM_ROLES, requireCap, strongestRole, type PlatformRole } from './roles';
import { signInResetEmail } from '../auth/email';
import { actor, fail, field, isoNow, orgName, parseBody, tryDecrypt, userOwner, userProfile } from './util';
import { siteOf } from '../../shared/site';

export const supportApp = new Hono<AppContext>();

export const RESET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

type Staff = { id: string; role: PlatformRole };

async function staff(c: Context<AppContext>): Promise<Staff> {
  const { user } = actor(c);
  const role = strongestRole(await getPlatformRoles(c.env, user.id));
  if (!role) fail(403, 'forbidden'); // requireCap ran; a role revoked in between ends here
  return { id: user.id, role };
}

export const rank = (r: PlatformRole | null | undefined): number => (r ? PLATFORM_ROLES.indexOf(r) + 1 : 0);

/** True when `actorRole` ranks strictly above the target's strongest platform role (none = 0). */
async function outranks(env: Env, actorRole: PlatformRole | null, userId: string): Promise<boolean> {
  return rank(actorRole) > rank(strongestRole(await getPlatformRoles(env, userId)));
}

type Target = { id: string; status: string; disabledBy: string | null; disabledByRole: PlatformRole | null };

/** 404 for unknown users; 403 unless the actor strictly outranks the target's platform role. */
async function assertMayActOn(env: Env, me: Staff, userId: string): Promise<Target> {
  const row = await env.DB.prepare('SELECT id, status, disabledBy, disabledByRole FROM user WHERE id = ?')
    .bind(userId)
    .first<{ id: string; status: string | null; disabledBy: string | null; disabledByRole: string | null }>();
  if (!row) fail(404, 'user_not_found');
  if (!(await outranks(env, me.role, userId))) fail(403, 'target_outranks_you');
  const role = (PLATFORM_ROLES as readonly string[]).includes(row.disabledByRole ?? '') ? (row.disabledByRole as PlatformRole) : null;
  return { id: row.id, status: row.status ?? 'active', disabledBy: row.disabledBy, disabledByRole: role };
}

/** Unix ms from Better Auth date columns (ISO text) or numbers (seconds or ms). */
function toMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toMs(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Ends every control-plane session of the user (rows deleted, so the cookie and any identity
 * token renewal stop working) and drops their gate sessions on every instance they can reach.
 */
export async function endAllSessions(env: Env, userId: string): Promise<number> {
  const res = await env.DB.prepare('DELETE FROM session WHERE userId = ?').bind(userId).run();
  await dropGateSessionsForUser(env, userId);
  return res.meta.changes ?? 0;
}

// ---- find a user ------------------------------------------------------------------------------

const lookupQuery = z.object({ email: z.email().max(320) });

supportApp.get('/users', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const parsed = lookupQuery.safeParse({ email: c.req.query('email') });
  if (!parsed.success) fail(400, 'exact_email_required');
  const idx = await deps().keyRing(c.env).emailIndex(parsed.data.email);
  const row = await c.env.DB.prepare(
    'SELECT id, status, createdAt, registeredVia, signupTier, registrationCodeId FROM user WHERE emailIndex = ?',
  )
    .bind(idx)
    .first<{ id: string; status: string | null; createdAt: unknown; registeredVia: string | null; signupTier: string | null; registrationCodeId: string | null }>();
  // Who looked up whom; misses too, so probing for addresses leaves a trace. Never the address.
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'support.user_looked_up',
    targetType: 'user',
    targetId: row?.id ?? null,
    details: { found: !!row },
  });
  if (!row) fail(404, 'user_not_found');
  const id = row.id;
  const env = c.env;

  const profile = await userProfile(env, id);
  const memberRows = await env.DB.prepare('SELECT organizationId AS orgId, role, createdAt FROM member WHERE userId = ? ORDER BY createdAt')
    .bind(id)
    .all<{ orgId: string; role: string; createdAt: unknown }>();
  const orgs = [];
  for (const m of memberRows.results) orgs.push({ id: m.orgId, name: await orgName(env, m.orgId), role: m.role, joinedAt: m.createdAt });

  const passkeys = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkey WHERE userId = ?').bind(id).first<{ n: number }>();
  const providers = await env.DB.prepare('SELECT DISTINCT providerId FROM account WHERE userId = ? ORDER BY providerId')
    .bind(id)
    .all<{ providerId: string }>();

  const now = Date.now();
  const sessions = await env.DB.prepare('SELECT createdAt, expiresAt, method FROM session WHERE userId = ?')
    .bind(id)
    .all<{ createdAt: unknown; expiresAt: unknown; method: string | null }>();
  let lastSignIn: { at: number; method: string | null } | null = null;
  for (const s of sessions.results) {
    const at = toMs(s.createdAt);
    if (!lastSignIn || at > lastSignIn.at) lastSignIn = { at, method: s.method ?? null };
  }
  // Signed-out sessions are gone; the sign-in audit entries (30 days, D57) remember them.
  const audited = await env.DB.prepare(
    "SELECT at, details FROM audit_platform WHERE action = 'auth.signed_in' AND target_id = ? ORDER BY at DESC LIMIT 1",
  )
    .bind(id)
    .first<{ at: number; details: string | null }>();
  if (audited && (!lastSignIn || audited.at > lastSignIn.at)) {
    let method: string | null = null;
    try {
      const d = audited.details ? (JSON.parse(audited.details) as { method?: unknown }) : null;
      method = typeof d?.method === 'string' ? d.method : null;
    } catch {
      method = null;
    }
    lastSignIn = { at: audited.at, method };
  }

  return c.json({
    id,
    name: profile?.name ?? null,
    email: profile?.email ?? null,
    status: row.status ?? 'active',
    createdAt: row.createdAt,
    registeredVia: row.registeredVia,
    signupTier: row.signupTier,
    registrationCodeId: row.registrationCodeId,
    orgs,
    signInMethods: { passkeys: passkeys?.n ?? 0, providers: providers.results.map((p) => p.providerId) },
    platformRoles: await getPlatformRoles(env, id),
    lastSignIn,
    activeSessions: sessions.results.filter((s) => toMs(s.expiresAt) > now).length,
  });
});

// ---- sign out everywhere, disable, enable -----------------------------------------------------

supportApp.post('/users/:id/sign-out', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const target = await assertMayActOn(c.env, me, c.req.param('id'));
  const sessions = await endAllSessions(c.env, target.id);
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'support.user_signed_out', targetType: 'user', targetId: target.id, details: { sessions } });
  return c.json({ ok: true, sessionsEnded: sessions });
});

supportApp.post('/users/:id/disable', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const userId = c.req.param('id');
  if (userId === me.id) fail(403, 'cannot_disable_self');
  const target = await assertMayActOn(c.env, me, userId);
  if (target.status === 'pending') fail(409, 'user_pending'); // enabling would skip the waitlist
  // Last-superadmin guard in the same statement: another active superadmin must remain.
  const res = await c.env.DB.prepare(
    `UPDATE user SET status = 'disabled', updatedAt = ?, disabledBy = ?, disabledByRole = ? WHERE id = ? AND status = 'active'
       AND (NOT EXISTS (SELECT 1 FROM platform_roles WHERE user_id = ? AND role = 'superadmin')
            OR EXISTS (SELECT 1 FROM platform_roles pr JOIN user u ON u.id = pr.user_id
                       WHERE pr.role = 'superadmin' AND pr.user_id != ? AND u.status = 'active'))`,
  )
    .bind(isoNow(), me.id, me.role, userId, userId, userId)
    .run();
  if (!res.meta.changes) {
    const now = await c.env.DB.prepare('SELECT status FROM user WHERE id = ?').bind(userId).first<{ status: string | null }>();
    if (now?.status !== 'disabled') fail(409, 'last_superadmin');
    // Already disabled: ending sessions again is harmless and closes anything that slipped in.
  }
  const sessions = await endAllSessions(c.env, userId);
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'support.user_disabled',
    targetType: 'user',
    targetId: userId,
    details: { sessions, alreadyDisabled: !res.meta.changes },
  });
  return c.json({ ok: true, sessionsEnded: sessions });
});

supportApp.post('/users/:id/enable', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const target = await assertMayActOn(c.env, me, c.req.param('id'));
  if (target.status !== 'disabled') fail(409, 'not_disabled');
  // A superadmin's disable can only be undone by a superadmin (rank at the time it was disabled).
  if (rank(me.role) < rank(target.disabledByRole)) fail(403, 'disabler_outranks_you');
  const res = await c.env.DB.prepare(
    `UPDATE user SET status = 'active', updatedAt = ?, disabledBy = NULL, disabledByRole = NULL
      WHERE id = ? AND status = 'disabled' AND disabledBy IS ? AND disabledByRole IS ?`,
  )
    .bind(isoNow(), target.id, target.disabledBy, target.disabledByRole)
    .run();
  if (!res.meta.changes) fail(409, 'not_disabled');
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'support.user_enabled',
    targetType: 'user',
    targetId: target.id,
    details: { disabledBy: target.disabledBy },
  });
  return c.json({ ok: true });
});

// ---- two-person sign-in reset -----------------------------------------------------------------

const reasonField = (requestId: string, userId: string) => field('support_requests', 'reason', requestId, userOwner(userId));

supportApp.post('/users/:id/reset-signin', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const userId = c.req.param('id');
  if (userId === me.id) fail(403, 'cannot_reset_self');
  const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(1000) }));
  const target = await assertMayActOn(c.env, me, userId);
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + RESET_REQUEST_TTL_MS;
  const ring = deps().keyRing(c.env);
  await ring.ensureKey(userOwner(target.id));
  const encReason = await ring.encrypt(reasonField(id, target.id), reason);
  // One open request per user, decided in the insert itself.
  const res = await c.env.DB.prepare(
    `INSERT INTO support_requests (id, kind, user_id, requested_by, reason, created_at, expires_at, status)
     SELECT ?, 'signin_reset', ?, ?, ?, ?, ?, 'open'
     WHERE NOT EXISTS (SELECT 1 FROM support_requests WHERE user_id = ? AND kind = 'signin_reset' AND status = 'open' AND expires_at > ?)`,
  )
    .bind(id, target.id, me.id, encReason, now, expiresAt, target.id, now)
    .run();
  if (!res.meta.changes) fail(409, 'request_already_open');
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'support.reset_requested', targetType: 'user', targetId: target.id, details: { requestId: id } });
  return c.json({ id, kind: 'signin_reset', userId: target.id, expiresAt }, 201);
});

/** Open, unexpired requests, with the target's address and the reason so the approver can judge. */
supportApp.get('/support-requests', requireCap('users.support'), async (c) => {
  const me = await staff(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, user_id AS userId, requested_by AS requestedBy, reason, created_at AS createdAt, expires_at AS expiresAt
     FROM support_requests WHERE status = 'open' AND expires_at > ? ORDER BY created_at`,
  )
    .bind(Date.now())
    .all<{ id: string; kind: string; userId: string; requestedBy: string; reason: string; createdAt: number; expiresAt: number }>();
  const requests = [];
  for (const r of rows.results) {
    const profile = await userProfile(c.env, r.userId);
    requests.push({
      ...r,
      reason: await tryDecrypt(c.env, reasonField(r.id, r.userId), r.reason),
      email: profile?.email ?? null,
      name: profile?.name ?? null,
      canApprove: r.requestedBy !== me.id && r.userId !== me.id && (await outranks(c.env, me.role, r.userId)),
    });
  }
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'support.requests_viewed', targetType: 'system', targetId: null, details: { count: requests.length } });
  return c.json({ requests });
});

supportApp.post('/support-requests/:id/approve', requireCap('users.support'), async (c) => {
  const { session } = actor(c);
  // requireCap checked mfa; the approval itself must come from a passkey sign-in (D24).
  if (session.method !== 'passkey' || !session.mfa) fail(403, 'passkey_required');
  const me = await staff(c);
  const id = c.req.param('id');
  const req = await c.env.DB.prepare('SELECT id, kind, user_id, requested_by, status, expires_at FROM support_requests WHERE id = ?')
    .bind(id)
    .first<{ id: string; kind: string; user_id: string; requested_by: string; status: string; expires_at: number }>();
  if (!req) fail(404, 'not_found');
  if (req.status !== 'open') fail(409, 'not_open');
  const now = Date.now();
  if (req.expires_at <= now) fail(410, 'expired');
  if (req.requested_by === me.id) fail(403, 'second_person_required');
  if (req.user_id === me.id) fail(403, 'cannot_approve_own_reset');
  await assertMayActOn(c.env, me, req.user_id);
  // The requester must still be staff who could make the request now: active, with the
  // capability, and still strictly outranking the target (roles may have changed since).
  const requester = await c.env.DB.prepare('SELECT status FROM user WHERE id = ?').bind(req.requested_by).first<{ status: string | null }>();
  const requesterRoles = await getPlatformRoles(c.env, req.requested_by);
  if (requester?.status !== 'active' || !can(requesterRoles, 'users.support')) fail(409, 'requester_not_staff');
  if (!(await outranks(c.env, strongestRole(requesterRoles), req.user_id))) fail(409, 'requester_outranked');

  // Claim atomically: one approval, never after expiry, never by the requester or the target.
  const claim = await c.env.DB.prepare(
    `UPDATE support_requests SET status = 'approved', approved_by = ?, approved_at = ?
     WHERE id = ? AND status = 'open' AND expires_at > ? AND requested_by != ? AND user_id != ?`,
  )
    .bind(me.id, now, id, now, me.id, me.id)
    .run();
  if (!claim.meta.changes) fail(409, 'not_open');

  const [passkeys, sessions] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM passkey WHERE userId = ?').bind(req.user_id),
    c.env.DB.prepare('DELETE FROM session WHERE userId = ?').bind(req.user_id),
    c.env.DB.prepare("UPDATE support_requests SET status = 'executed', executed_at = ? WHERE id = ?").bind(Date.now(), id),
  ]);
  await dropGateSessionsForUser(c.env, req.user_id);
  const removed = { passkeys: passkeys?.meta.changes ?? 0, sessions: sessions?.meta.changes ?? 0 };
  await auditPlatform(c.env, {
    actorId: me.id,
    actorRole: me.role,
    action: 'support.reset_executed',
    targetType: 'user',
    targetId: req.user_id,
    details: { requestId: id, requestedBy: req.requested_by, ...removed },
  });

  const profile = await userProfile(c.env, req.user_id);
  if (profile?.email) {
    try {
      await deps().sendEmail(c.env, { to: profile.email, ...signInResetEmail(siteOf(c.env)) });
    } catch (err) {
      console.error(JSON.stringify({ at: 'support.reset_mail', requestId: id, message: (err as Error).message }));
    }
  }
  return c.json({ ok: true, ...removed });
});

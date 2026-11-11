// Audit trail (D40, D41, D57). Platform log: ids and numbers only. Org log: details encrypted
// with the org key. A failed write never breaks the request it describes: retried once, then
// counted in KV.
import { z } from 'zod';
import type { Env } from '../env';
import { deps } from './deps';
import { fail, field, orgOwner } from './util';

export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // D57

export type AuditAction =
  // orgs
  | 'org.created'
  | 'org.renamed'
  | 'org.deleted'
  | 'org.tier_changed'
  | 'org.release_candidates_set'
  | 'org.key_rotated'
  | 'org.policy_updated'
  | 'org.egress_updated'
  | 'org.audit_viewed'
  // members, invitations
  | 'member.role_changed'
  | 'member.removed'
  | 'invitation.created'
  | 'invitation.canceled'
  | 'invitation.resent'
  // teams
  | 'team.created'
  | 'team.renamed'
  | 'team.deleted'
  | 'team.member_added'
  | 'team.member_removed'
  // instances (tenancy-side)
  | 'instance.policy_updated'
  | 'instance.stopped'
  | 'instance.stop_lifted'
  // instances (lifecycle, src/control/instances)
  | 'instance.create_started'
  | 'instance.created'
  | 'instance.create_failed'
  | 'instance.renamed'
  | 'instance.provider_settings_set'
  | 'instance.teams_changed'
  | 'instance.upgrade_started'
  | 'instance.upgraded'
  | 'instance.upgrade_rolled_back'
  | 'instance.auto_update_set'
  | 'instance.remote_access_set'
  | 'instance.size_set'
  | 'instance.egress_set'
  | 'instance.egress_reset'
  | 'instance.suspended'
  | 'instance.delete_started'
  | 'instance.deleted'
  // sign-in and bootstrap (src/control/auth)
  | 'auth.signed_in'
  | 'auth.sign_in_failed'
  | 'auth.signed_out'
  | 'auth.passkey_added'
  | 'platform.bootstrapped'
  // domains, SSO
  | 'domain.added'
  | 'domain.verified'
  | 'domain.verify_failed'
  | 'domain.removed'
  | 'sso.registered'
  | 'sso.removed'
  // confirmations
  | 'confirmation.started'
  | 'confirmation.completed'
  // platform
  | 'platform.role_granted'
  | 'platform.role_revoked'
  | 'platform.registration_mode_set'
  | 'platform.worca_version_set'
  | 'platform.release_enrolled'
  | 'platform.release_held'
  | 'platform.release_withdrawn'
  | 'platform.release_restored'
  | 'platform.release_settings_set'
  | 'platform.tier_created'
  | 'platform.tier_updated'
  | 'platform.tier_deleted'
  | 'platform.provider_settings_set'
  | 'platform.code_created'
  | 'platform.code_revoked'
  | 'platform.waitlist_approved'
  | 'platform.waitlist_viewed'
  | 'platform.waitlist_rejected'
  | 'platform.audit_viewed'
  // access requests (D69, access-requests-routes.ts)
  | 'platform.access_requests_viewed'
  | 'platform.access_request_granted'
  | 'platform.access_request_declined'
  // users
  | 'user.renamed'
  | 'user.exported'
  | 'user.deleted'
  // platform support (P8, support-routes.ts)
  | 'support.user_looked_up'
  | 'support.user_signed_out'
  | 'support.user_disabled'
  | 'support.user_enabled'
  | 'support.reset_requested'
  | 'support.reset_executed'
  | 'support.requests_viewed'
  | 'platform.master_key_rotated'
  | 'auth.session_revoked'
  | 'auth.other_sessions_revoked'
  | 'instance.op_restarted'
  | 'audit.pruned'
  // newsletter (D70)
  | 'newsletter.release_queued';

export type AuditTargetType = 'org' | 'member' | 'user' | 'team' | 'invitation' | 'instance' | 'domain' | 'sso' | 'confirmation' | 'code' | 'setting' | 'system' | 'access_request' | 'release' | 'tier';

export type PlatformActorRole = 'superadmin' | 'admin' | 'support' | 'user' | 'system';
export type OrgActorScope = 'tenant' | 'platform' | 'system';

/** Values allowed in platform-log details: ids, enum values and numbers. */
export type PlatformDetails = Record<string, string | number | boolean | null>;

export interface PlatformAuditEvent {
  actorId: string | null;
  actorRole: PlatformActorRole | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string | null;
  details?: PlatformDetails;
}

export interface OrgAuditEvent {
  actorId: string | null;
  actorScope: OrgActorScope;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string | null;
  details?: Record<string, unknown>;
}

export const auditFailureKey = (day: string): string => `audit:failures:${day}`;

// Strings in platform details must look like ids or enum values, never free text (D15).
const SAFE_STRING = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitizePlatformDetails(details: PlatformDetails | undefined): PlatformDetails | null {
  if (!details) return null;
  const out: PlatformDetails = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'string' && !SAFE_STRING.test(v)) out[k] = '[redacted]';
    else out[k] = v;
  }
  return out;
}

async function writeWithRetry(env: Env, label: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
    return;
  } catch {
    // retry once below
  }
  try {
    await write();
  } catch (err) {
    console.error(JSON.stringify({ at: 'audit', label, message: (err as Error).message }));
    try {
      const key = auditFailureKey(new Date().toISOString().slice(0, 10));
      const count = Number.parseInt((await env.KV.get(key)) ?? '0', 10) + 1;
      await env.KV.put(key, String(count), { expirationTtl: 60 * 60 * 24 * 14 });
    } catch {
      // KV down too: the log line above is the last resort.
    }
  }
}

export async function auditPlatform(env: Env, e: PlatformAuditEvent): Promise<void> {
  const id = crypto.randomUUID();
  const details = sanitizePlatformDetails(e.details);
  await writeWithRetry(env, e.action, () =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO audit_platform (id, at, actor_id, actor_role, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, Date.now(), e.actorId, e.actorRole, e.action, e.targetType, e.targetId, details ? JSON.stringify(details) : null)
      .run(),
  );
}

export async function auditOrg(env: Env, orgId: string, e: OrgAuditEvent): Promise<void> {
  const id = crypto.randomUUID();
  await writeWithRetry(env, e.action, async () => {
    const details = e.details
      ? await deps().keyRing(env).encrypt(field('audit_org', 'details', id, orgOwner(orgId)), JSON.stringify(e.details))
      : null;
    await env.DB.prepare(
      'INSERT OR IGNORE INTO audit_org (id, org_id, at, actor_id, actor_scope, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, orgId, Date.now(), e.actorId, e.actorScope, e.action, e.targetType, e.targetId, details)
      .run();
  });
}

/** D57: deletes entries older than 30 days from both logs. Run daily from the crons. */
export async function pruneAudit(env: Env, now = Date.now()): Promise<{ platform: number; org: number }> {
  const cutoff = now - AUDIT_RETENTION_MS;
  const [p, o] = await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_platform WHERE at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM audit_org WHERE at < ?').bind(cutoff),
  ]);
  const counts = { platform: p?.meta.changes ?? 0, org: o?.meta.changes ?? 0 };
  await auditPlatform(env, { actorId: null, actorRole: 'system', action: 'audit.pruned', targetType: 'system', targetId: null, details: counts });
  return counts;
}

// ---- reading: filters and categories (T12, P9) -------------------------------------------------

/** UI groupings over the plaintext `action` column. Every action falls in exactly one. */
export const AUDIT_CATEGORIES = ['instances', 'members', 'security', 'settings'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

// Patterns ending in '.' or '_' match by prefix, the others exactly. Order matters only for
// auditCategoryOf; the SQL clauses are disjoint by construction.
const CATEGORY_PATTERNS: Record<AuditCategory, readonly string[]> = {
  instances: ['instance.'],
  members: ['member.', 'invitation.', 'team.', 'user.', 'platform.waitlist_', 'platform.code_', 'platform.access_request_', 'platform.access_requests_viewed'],
  security: [
    'auth.',
    'domain.',
    'sso.',
    'confirmation.',
    'platform.role_',
    'platform.bootstrapped',
    'org.key_rotated',
    'org.policy_updated',
    'org.egress_updated',
    'org.audit_viewed',
    'platform.audit_viewed',
    'audit.pruned',
    'support.',
    'platform.master_key_rotated',
  ],
  settings: ['org.created', 'org.renamed', 'org.deleted', 'org.tier_changed', 'org.release_candidates_set', 'platform.registration_mode_set', 'platform.worca_version_set', 'platform.release_', 'platform.tier_', 'platform.provider_', 'newsletter.'],
};

const isPrefix = (p: string) => p.endsWith('.') || p.endsWith('_');

/** The category an action is shown under; unknown actions land in 'settings'. */
export function auditCategoryOf(action: string): AuditCategory {
  for (const cat of AUDIT_CATEGORIES) {
    if (CATEGORY_PATTERNS[cat].some((p) => (isPrefix(p) ? action.startsWith(p) : action === p))) return cat;
  }
  return 'settings';
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export interface AuditFilter {
  before?: number;
  limit?: number;
  actorId?: string;
  /** Prefix of the action, e.g. `instance.` or `member.role_changed`. */
  action?: string;
  category?: AuditCategory;
}

const auditQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().optional(), // clamped to 1..500 when read
  actorId: z.string().min(1).max(64).optional(),
  action: z.string().regex(/^[a-z_.]{1,64}$/).optional(),
  category: z.enum(AUDIT_CATEGORIES).optional(),
});

/** Query-string filters of both audit endpoints; 400 on anything malformed. */
export function parseAuditQuery(query: Record<string, string | undefined>): AuditFilter {
  const picked = Object.fromEntries(Object.entries(query).filter(([k, v]) => k in auditQuerySchema.shape && v !== undefined && v !== ''));
  const parsed = auditQuerySchema.safeParse(picked);
  if (!parsed.success) fail(400, 'invalid_query');
  return parsed.data;
}

/** WHERE clauses and binds for the filters; only plaintext columns are touched. */
function filterSql(f: AuditFilter): { where: string[]; binds: unknown[] } {
  const where = ['at < ?'];
  const binds: unknown[] = [f.before ?? Number.MAX_SAFE_INTEGER];
  if (f.actorId) {
    where.push('actor_id = ?');
    binds.push(f.actorId);
  }
  if (f.action) {
    where.push("action LIKE ? ESCAPE '\\'");
    binds.push(likePrefix(f.action));
  }
  if (f.category) {
    const ors: string[] = [];
    for (const p of CATEGORY_PATTERNS[f.category]) {
      ors.push(isPrefix(p) ? "action LIKE ? ESCAPE '\\'" : 'action = ?');
      binds.push(isPrefix(p) ? likePrefix(p) : p);
    }
    if (f.category === 'settings') {
      // Catch-all, mirroring auditCategoryOf: anything no other category claims.
      const others: string[] = [];
      for (const cat of AUDIT_CATEGORIES) {
        if (cat === 'settings') continue;
        for (const p of CATEGORY_PATTERNS[cat]) {
          others.push(isPrefix(p) ? "action LIKE ? ESCAPE '\\'" : 'action = ?');
          binds.push(isPrefix(p) ? likePrefix(p) : p);
        }
      }
      ors.push(`NOT (${others.join(' OR ')})`);
    }
    where.push(`(${ors.join(' OR ')})`);
  }
  return { where, binds };
}

const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 100, 1), 500);

export interface OrgAuditEntry {
  id: string;
  at: number;
  actorId: string | null;
  actorScope: string;
  action: string;
  category: AuditCategory;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
}

/** D41: the org's log, decrypted, newest first. */
export async function readOrgAudit(env: Env, orgId: string, opts: AuditFilter = {}): Promise<OrgAuditEntry[]> {
  const { where, binds } = filterSql(opts);
  const rows = await env.DB.prepare(
    `SELECT id, at, actor_id, actor_scope, action, target_type, target_id, details FROM audit_org WHERE org_id = ? AND ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`,
  )
    .bind(orgId, ...binds, clampLimit(opts.limit))
    .all<{ id: string; at: number; actor_id: string | null; actor_scope: string; action: string; target_type: string | null; target_id: string | null; details: string | null }>();
  const ring = deps().keyRing(env);
  const out: OrgAuditEntry[] = [];
  for (const r of rows.results) {
    let details: unknown = null;
    if (r.details) {
      try {
        details = JSON.parse(await ring.decrypt(field('audit_org', 'details', r.id, orgOwner(orgId)), r.details));
      } catch {
        details = null;
      }
    }
    out.push({
      id: r.id,
      at: r.at,
      actorId: r.actor_id,
      actorScope: r.actor_scope,
      action: r.action,
      category: auditCategoryOf(r.action),
      targetType: r.target_type,
      targetId: r.target_id,
      details,
    });
  }
  return out;
}

export interface PlatformAuditEntry {
  id: string;
  at: number;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  category: AuditCategory;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
}

/** D40: the platform log, newest first. Details are ids and numbers, stored as plain JSON. */
export async function readPlatformAudit(env: Env, opts: AuditFilter = {}): Promise<PlatformAuditEntry[]> {
  const { where, binds } = filterSql(opts);
  const rows = await env.DB.prepare(
    `SELECT id, at, actor_id, actor_role, action, target_type, target_id, details FROM audit_platform WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`,
  )
    .bind(...binds, clampLimit(opts.limit))
    .all<{ id: string; at: number; actor_id: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; details: string | null }>();
  return rows.results.map((r) => {
    let details: unknown = null;
    try {
      details = r.details ? JSON.parse(r.details) : null;
    } catch {
      details = null;
    }
    return {
      id: r.id,
      at: r.at,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      action: r.action,
      category: auditCategoryOf(r.action),
      targetType: r.target_type,
      targetId: r.target_id,
      details,
    };
  });
}

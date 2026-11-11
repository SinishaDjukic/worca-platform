// Tenant console API, mounted at /api/orgs (D17, D18, D21, D29–D31, D38, D41).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { bumpCounter, readCounter, utcDay } from '../auth/rate-limit';
import { canCreateOrganization } from '../auth/registration';
import { auditOrg, auditPlatform, parseAuditQuery, readOrgAudit } from './audit';
import { getOrgKeyInfo } from '../keys-jobs';
import { deliveryStatusFor, invitationMailRef } from '../system/mail';
import { confirmationSent, registerConfirmAction, startConfirmation } from './confirmations';
import { deps } from './deps';
import { domainsApp } from './domains';
import { computeSizes } from '../instances/sizes';
import { deleteOrgNow } from './lifecycle';
import { policyApp } from './policy-routes';
import { requireMfa, requireOrgRole, requireUser } from './roles';
import { teamsApp } from './teams';
import {
  actor,
  dropGateSessions,
  fail,
  field,
  memberRole,
  orgInstanceIds,
  orgName,
  orgOwner,
  parseBody,
  randomSlug,
  TENANT_ROLES,
  tryDecrypt,
  userOwner,
  userProfile,
} from './util';

import { featureOn } from '../features';
export const tenantApp = new Hono<AppContext>();

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const confirmNameSchema = z.object({ confirmName: z.string() });
const roleSchema = z.enum(TENANT_ROLES as [string, ...string[]]);

async function tierOf(env: Env, orgId: string) {
  return env.DB.prepare(
    `SELECT s.tier, s.status, s.created_at, t.name AS tier_name, t.instances_per_org, t.vcpu, t.memory_mb, t.volume_gb, t.members, t.sizes, t.default_size
     FROM org_settings s LEFT JOIN tiers t ON t.id = s.tier WHERE s.org_id = ?`,
  )
    .bind(orgId)
    .first<{ tier: string; status: string; created_at: number; tier_name: string | null; instances_per_org: number; vcpu: number; memory_mb: number; volume_gb: number; members: number; sizes: string | null; default_size: string | null }>();
}

async function defaultTier(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'default_tier'").first<{ value: string }>();
  return row?.value ?? 'free';
}

// ---- orgs -------------------------------------------------------------------------------------

/** Any active user may create an org and becomes its first tenant admin (D17, D18, D21). */
tenantApp.post('/', requireUser, async (c) => {
  const { user } = actor(c);
  const { name } = await parseBody(c, nameSchema);
  // Better Auth's allowUserToCreateOrganization isn't consulted for server-side calls with a
  // userId, so the registration rule (D25) is checked here: people who only joined through an
  // invitation can't open their own org until registration is open.
  const row = await c.env.DB.prepare('SELECT status, registeredVia FROM user WHERE id = ?').bind(user.id).first<Record<string, unknown>>();
  if (!row || !(await canCreateOrganization(c.env, row))) fail(403, 'org_creation_not_allowed');
  const { id } = await deps().auth.createOrganization(c.env, { userId: user.id, name, slug: randomSlug() });
  await deps().keyRing(c.env).ensureKey(orgOwner(id));
  const tier = await defaultTier(c.env);
  await c.env.DB.batch([
    // The organization plugin's creator role is configured as tenant_admin; make sure of it.
    c.env.DB.prepare("UPDATE member SET role = 'tenant_admin' WHERE organizationId = ? AND userId = ?").bind(id, user.id),
    c.env.DB.prepare('INSERT OR IGNORE INTO org_settings (org_id, tier, status, created_at) VALUES (?, ?, ?, ?)').bind(id, tier, 'active', Date.now()),
  ]);
  await auditPlatform(c.env, { actorId: user.id, actorRole: 'user', action: 'org.created', targetType: 'org', targetId: id, details: { tier } });
  await auditOrg(c.env, id, { actorId: user.id, actorScope: 'tenant', action: 'org.created', targetType: 'org', targetId: id, details: { name } });
  return c.json({ id }, 201);
});

tenantApp.get('/:orgId', requireOrgRole('any'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const org = await c.env.DB.prepare('SELECT id, slug FROM organization WHERE id = ?').bind(orgId).first<{ id: string; slug: string }>();
  if (!org) fail(404, 'not_found');
  const t = await tierOf(c.env, orgId);
  const tiers = featureOn(c.env, 'tiers'); // 2.4: without tiers an org has no plan to show
  return c.json({
    id: org.id,
    slug: org.slug,
    name: await orgName(c.env, orgId),
    role: await memberRole(c.env, orgId, user.id),
    status: t?.status ?? 'active',
    createdAt: t?.created_at ?? null,
    tier: t && tiers
      ? {
          id: t.tier,
          name: t.tier_name,
          instances: t.instances_per_org,
          vcpu: t.vcpu,
          memoryMb: t.memory_mb,
          volumeGb: t.volume_gb,
          members: t.members,
          sizes: computeSizes(c.env).parseTier(t.sizes), // D78
          defaultSize: t.default_size,
        }
      : null,
  });
});

tenantApp.patch('/:orgId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const { name } = await parseBody(c, nameSchema);
  const enc = await deps().keyRing(c.env).encrypt(field('organization', 'name', orgId, orgOwner(orgId)), name);
  await c.env.DB.prepare('UPDATE organization SET name = ? WHERE id = ?').bind(enc, orgId).run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'org.renamed', targetType: 'org', targetId: orgId, details: { name } });
  return c.json({ ok: true });
});

/** D29–D31: first confirmation is the typed name, the second the emailed link. */
tenantApp.delete('/:orgId', requireOrgRole('tenant_admin'), requireMfa, async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const { confirmName } = await parseBody(c, confirmNameSchema);
  const name = await orgName(c.env, orgId);
  if (name === null || confirmName !== name) fail(422, 'confirm_name_mismatch');
  const instances = (await orgInstanceIds(c.env, orgId)).length;
  const started = await startConfirmation(c.env, {
    userId: user.id,
    orgId,
    action: 'org.delete',
    target: orgId,
    summary: `Delete the organization "${name}" and its ${instances} instance(s). Everything is deleted immediately and permanently.`,
  });
  return confirmationSent(c, started);
});

registerConfirmAction('org.delete', (env, _ctx, { userId, target }) => deleteOrgNow(env, target, userId), { label: 'Delete the organization' });

// ---- members ----------------------------------------------------------------------------------

type SignInMethod = 'email-otp' | 'passkey' | 'google' | 'microsoft' | 'sso';

/**
 * How each member can sign in, from linked accounts and passkeys (no per-session data). Every
 * account has a verified email, so the email code is always there; other provider ids are SSO.
 */
async function signInMethods(env: Env, orgId: string): Promise<Map<string, { methods: SignInMethod[]; passkeys: number }>> {
  const [accounts, passkeys] = await env.DB.batch<{ userId: string; providerId?: string; n?: number }>([
    env.DB.prepare('SELECT DISTINCT a.userId, a.providerId FROM account a JOIN member m ON m.userId = a.userId WHERE m.organizationId = ?').bind(orgId),
    env.DB.prepare('SELECT p.userId, COUNT(*) AS n FROM passkey p JOIN member m ON m.userId = p.userId WHERE m.organizationId = ? GROUP BY p.userId').bind(orgId),
  ]);
  const found = new Map<string, Set<SignInMethod>>();
  const add = (userId: string, m: SignInMethod) => found.set(userId, (found.get(userId) ?? new Set<SignInMethod>()).add(m));
  for (const a of accounts?.results ?? []) {
    const p = a.providerId ?? '';
    if (p === 'google' || p === 'microsoft') add(a.userId, p);
    else if (p && p !== 'credential' && p !== 'email-otp') add(a.userId, 'sso');
  }
  const counts = new Map((passkeys?.results ?? []).map((r) => [r.userId, Number(r.n ?? 0)]));
  const order: SignInMethod[] = ['email-otp', 'passkey', 'google', 'microsoft', 'sso'];
  const out = new Map<string, { methods: SignInMethod[]; passkeys: number }>();
  for (const userId of new Set([...found.keys(), ...counts.keys()])) {
    const set = found.get(userId) ?? new Set<SignInMethod>();
    if (counts.get(userId)) set.add('passkey');
    out.set(userId, { methods: order.filter((m) => m === 'email-otp' || set.has(m)), passkeys: counts.get(userId) ?? 0 });
  }
  return out;
}

/**
 * Member directory, GitHub/Slack style: every member sees name, email, role and teams. Tenant
 * admins also get the join date, how each person signs in and who invited them.
 */
tenantApp.get('/:orgId/members', requireOrgRole('any'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const isAdmin = (await memberRole(c.env, orgId, user.id)) === 'tenant_admin';
  const [rows, teamRows] = await c.env.DB.batch<{ userId: string; role: string; createdAt: string; name: string; email: string; inviterId: string | null; teamId: string; teamName: string }>([
    c.env.DB.prepare(
      // The accepted invitation for the member's address (blind index), newest first.
      `SELECT m.userId, m.role, m.createdAt, u.name, u.email,
              (SELECT i.inviterId FROM invitation i WHERE i.organizationId = m.organizationId AND i.status = 'accepted'
                 AND u.emailIndex IS NOT NULL AND i.emailIndex = u.emailIndex ORDER BY i.createdAt DESC LIMIT 1) AS inviterId
       FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? ORDER BY m.createdAt`,
    ).bind(orgId),
    c.env.DB.prepare(
      'SELECT tm.userId, t.id AS teamId, t.name AS teamName FROM teamMember tm JOIN team t ON t.id = tm.teamId WHERE t.organizationId = ? ORDER BY t.createdAt',
    ).bind(orgId),
  ]);
  const teamNames = new Map<string, string | null>();
  const teamsOf = new Map<string, { id: string; name: string | null }[]>();
  for (const t of teamRows?.results ?? []) {
    if (!teamNames.has(t.teamId)) teamNames.set(t.teamId, await tryDecrypt(c.env, field('team', 'name', t.teamId, orgOwner(orgId)), t.teamName));
    teamsOf.set(t.userId, [...(teamsOf.get(t.userId) ?? []), { id: t.teamId, name: teamNames.get(t.teamId) ?? null }]);
  }
  const results = rows?.results ?? [];
  const names = new Map<string, string | null>();
  for (const r of results) names.set(r.userId, await tryDecrypt(c.env, field('user', 'name', r.userId, userOwner(r.userId)), r.name));
  const methods = isAdmin ? await signInMethods(c.env, orgId) : null;
  const members = [];
  for (const r of results) {
    const base = {
      userId: r.userId,
      role: r.role,
      name: names.get(r.userId) ?? null,
      email: await tryDecrypt(c.env, field('user', 'email', r.userId, userOwner(r.userId)), r.email),
      teams: teamsOf.get(r.userId) ?? [],
    };
    if (!methods) {
      members.push(base);
      continue;
    }
    let invitedBy: { userId: string; name: string | null } | null = null;
    if (r.inviterId) {
      // An inviter who has since left the org is still named; one whose account is gone is not.
      const name = names.has(r.inviterId) ? (names.get(r.inviterId) ?? null) : ((await userProfile(c.env, r.inviterId))?.name ?? null);
      invitedBy = { userId: r.inviterId, name };
    }
    members.push({
      ...base,
      joinedAt: r.createdAt,
      signsInWith: methods.get(r.userId) ?? { methods: ['email-otp'], passkeys: 0 },
      invitedBy,
    });
  }
  return c.json({ members });
});

// Conditional writes keep the last-tenant-admin guard (D18) safe against concurrent changes.
const OTHER_ADMINS = "(SELECT COUNT(*) FROM member x WHERE x.organizationId = member.organizationId AND x.role = 'tenant_admin' AND x.userId != member.userId)";

tenantApp.patch('/:orgId/members/:userId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const targetId = c.req.param('userId');
  const { user } = actor(c);
  const { role } = await parseBody(c, z.object({ role: roleSchema }));
  const current = await memberRole(c.env, orgId, targetId);
  if (!current) fail(404, 'not_found');
  if (current === role) return c.json({ ok: true });
  const res = await c.env.DB.prepare(
    `UPDATE member SET role = ? WHERE organizationId = ? AND userId = ? AND (role != 'tenant_admin' OR ${OTHER_ADMINS} > 0)`,
  )
    .bind(role, orgId, targetId)
    .run();
  if (!res.meta.changes) fail(409, 'last_tenant_admin');
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'member.role_changed', targetType: 'member', targetId, details: { from: current, to: role } });
  return c.json({ ok: true });
});

/** Admins remove anyone; any member may leave. Never the last tenant admin (D18). */
tenantApp.delete('/:orgId/members/:userId', requireOrgRole('any'), async (c) => {
  const orgId = c.req.param('orgId');
  const targetId = c.req.param('userId');
  const { user } = actor(c);
  if (targetId !== user.id && (await memberRole(c.env, orgId, user.id)) !== 'tenant_admin') fail(403, 'forbidden');
  if (!(await memberRole(c.env, orgId, targetId))) fail(404, 'not_found');
  const res = await c.env.DB.prepare(
    `DELETE FROM member WHERE organizationId = ? AND userId = ? AND (role != 'tenant_admin' OR ${OTHER_ADMINS} > 0)`,
  )
    .bind(orgId, targetId)
    .run();
  if (!res.meta.changes) fail(409, 'last_tenant_admin');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM teamMember WHERE userId = ? AND teamId IN (SELECT id FROM team WHERE organizationId = ?)').bind(targetId, orgId),
    c.env.DB.prepare('UPDATE team SET memberCount = (SELECT COUNT(*) FROM teamMember tm WHERE tm.teamId = team.id) WHERE organizationId = ?').bind(orgId),
  ]);
  await dropGateSessions(c.env, await orgInstanceIds(c.env, orgId), targetId); // D46
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'member.removed', targetType: 'member', targetId });
  return c.json({ ok: true });
});

// ---- invitations ------------------------------------------------------------------------------

const inviteSchema = z.object({ email: z.email().max(254), role: roleSchema.default('tenant_user'), teamId: z.string().optional() });

// Invitation mail shares the platform's Resend quota with sign-in codes, so it is capped:
// per org per UTC day across create and resend, and per invitation (its address in the org,
// so a replaced expired invitation keeps its count) a cooldown and a daily number of resends.
export const ORG_INVITATION_MAILS_PER_DAY = 50;
export const RESEND_COOLDOWN_S = 5 * 60;
export const RESENDS_PER_INVITATION_PER_DAY = 5;
const DAY_S = 86_400;

export const invitationMailKeys = (orgId: string, invitationKey: string, now = Date.now()) => ({
  org: `rl:invite-mail:${orgId}:${utcDay(now)}`,
  cooldown: `rl:invite-resend-last:${orgId}:${invitationKey}`,
  resends: `rl:invite-resend:${orgId}:${invitationKey}:${utcDay(now)}`,
});

/**
 * Counts one invitation mail against the limits, or answers 429. Checks every limit before
 * counting, so a refused resend doesn't use up the org's quota. `invitationKey` only for resends.
 */
async function reserveInvitationMail(env: Env, orgId: string, invitationKey?: string): Promise<void> {
  const now = Date.now();
  const keys = invitationMailKeys(orgId, invitationKey ?? '', now);
  if (invitationKey) {
    const last = Number((await env.KV.get(keys.cooldown)) ?? 0);
    if (last && now - last < RESEND_COOLDOWN_S * 1000) fail(429, 'resend_too_soon');
    if ((await readCounter(env.KV, keys.resends)) >= RESENDS_PER_INVITATION_PER_DAY) fail(429, 'invitation_mail_limit');
  }
  if ((await readCounter(env.KV, keys.org)) >= ORG_INVITATION_MAILS_PER_DAY) fail(429, 'invitation_mail_limit');
  await bumpCounter(env.KV, keys.org, 2 * DAY_S);
  if (invitationKey) {
    await bumpCounter(env.KV, keys.resends, 2 * DAY_S);
    await env.KV.put(keys.cooldown, String(now), { expirationTtl: RESEND_COOLDOWN_S });
  }
}

tenantApp.post('/:orgId/invitations', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const body = await parseBody(c, inviteSchema);
  // Better Auth refuses these too, but as an error the app would answer with a 500.
  const idx = await deps().keyRing(c.env).emailIndex(body.email);
  const [isMember, isInvited] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT 1 FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? AND u.emailIndex = ?').bind(orgId, idx),
    c.env.DB.prepare("SELECT 1 FROM invitation WHERE organizationId = ? AND emailIndex = ? AND status = 'pending' AND expiresAt > ?").bind(orgId, idx, new Date().toISOString()),
  ]);
  if (isMember?.results.length) fail(409, 'already_member');
  if (isInvited?.results.length) fail(409, 'already_invited');
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM member WHERE organizationId = ?1) AS members,
            (SELECT COUNT(*) FROM invitation WHERE organizationId = ?1 AND status = 'pending') AS pending`,
  )
    .bind(orgId)
    .first<{ members: number; pending: number }>();
  if (featureOn(c.env, 'tiers')) {
    const limit = (await tierOf(c.env, orgId))?.members ?? 0;
    if ((counts?.members ?? 0) + (counts?.pending ?? 0) >= limit) fail(409, 'member_limit'); // D33
  }
  if (body.teamId) {
    const team = await c.env.DB.prepare('SELECT 1 FROM team WHERE id = ? AND organizationId = ?').bind(body.teamId, orgId).first();
    if (!team) fail(404, 'team_not_found');
  }
  await reserveInvitationMail(c.env, orgId);
  const inv = await deps().auth.createInvitation(c.env, { headers: c.req.raw.headers, orgId, email: body.email, role: body.role, teamId: body.teamId });
  // The organization plugin's sendInvitationEmail (auth/index.ts) mails the invitation.
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'invitation.created', targetType: 'invitation', targetId: inv.id, details: { email: body.email, role: body.role } });
  return c.json({ id: inv.id, expiresAt: inv.expiresAt }, 201);
});

tenantApp.get('/:orgId/invitations', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.email, i.role, i.status, i.expiresAt, i.createdAt, i.inviterId, i.teamId, u.name AS inviterName
     FROM invitation i LEFT JOIN user u ON u.id = i.inviterId
     WHERE i.organizationId = ? AND i.status = 'pending' ORDER BY i.expiresAt`,
  )
    .bind(orgId)
    .all<{ id: string; email: string; role: string; status: string; expiresAt: string; createdAt: string; inviterId: string; teamId: string | null; inviterName: string | null }>();
  const invitations = [];
  for (const { inviterName, ...r } of rows.results) {
    invitations.push({
      ...r,
      email: await tryDecrypt(c.env, field('invitation', 'email', r.id, orgOwner(orgId)), r.email),
      inviter: { userId: r.inviterId, name: await tryDecrypt(c.env, field('user', 'name', r.inviterId, userOwner(r.inviterId)), inviterName) },
      expired: new Date(r.expiresAt).getTime() <= Date.now(),
      // Last mail event from Resend's webhook: accepted, delivered, bounced, … (null before 0012).
      delivery: await deliveryStatusFor(c.env, invitationMailRef(r.id)).catch(() => null),
    });
  }
  return c.json({ invitations });
});

/**
 * T9: mails the invitation again with a fresh expiry. Not subject to the member limit (D33): the
 * pending invitation already holds its seat. Better Auth's resend only finds unexpired
 * invitations; for an expired one it creates a new invitation, and the old one is canceled here.
 * Limited to one resend per 5 minutes and 5 a day per invitation, within the org's daily cap.
 */
tenantApp.post('/:orgId/invitations/:id/resend', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const id = c.req.param('id');
  const { user } = actor(c);
  const inv = await c.env.DB.prepare("SELECT id, email, emailIndex, role, teamId FROM invitation WHERE id = ? AND organizationId = ? AND status = 'pending'")
    .bind(id, orgId)
    .first<{ id: string; email: string; emailIndex: string | null; role: string | null; teamId: string | null }>();
  if (!inv) fail(404, 'not_found');
  const email = await tryDecrypt(c.env, field('invitation', 'email', inv.id, orgOwner(orgId)), inv.email);
  if (!email) fail(409, 'invitation_unreadable');
  await reserveInvitationMail(c.env, orgId, inv.emailIndex ?? inv.id);
  const res = await deps().auth.createInvitation(c.env, {
    headers: c.req.raw.headers,
    orgId,
    email,
    role: inv.role ?? 'tenant_user',
    teamId: inv.teamId ?? undefined,
    resend: true,
  });
  if (res.id !== inv.id) {
    await c.env.DB.prepare("UPDATE invitation SET status = 'canceled' WHERE id = ? AND organizationId = ? AND status = 'pending'").bind(inv.id, orgId).run();
  }
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'invitation.resent', targetType: 'invitation', targetId: res.id, details: { email, previousId: res.id !== inv.id ? inv.id : undefined } });
  return c.json({ id: res.id, expiresAt: res.expiresAt });
});

tenantApp.delete('/:orgId/invitations/:id', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const id = c.req.param('id');
  const { user } = actor(c);
  const res = await c.env.DB.prepare("UPDATE invitation SET status = 'canceled' WHERE id = ? AND organizationId = ? AND status = 'pending'").bind(id, orgId).run();
  if (!res.meta.changes) fail(404, 'not_found');
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'invitation.canceled', targetType: 'invitation', targetId: id });
  return c.json({ ok: true });
});

// ---- audit log and keys -----------------------------------------------------------------------

/**
 * D41: tenant admins read their own org's log, platform actions on it included. Filters (T12):
 * before, limit, actorId, action (prefix) and category. CSV export is built in the browser.
 */
tenantApp.get('/:orgId/audit', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  return c.json({ entries: await readOrgAudit(c.env, orgId, parseAuditQuery(c.req.query())) });
});

/** T13: the org key's version, last rotation and the progress of re-encryption. */
tenantApp.get('/:orgId/keys', requireOrgRole('tenant_admin'), async (c) => c.json(await getOrgKeyInfo(c.env, c.req.param('orgId'))));

export const ORG_KEY_ROTATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * D38: a new org key version; KeyRotationWorkflow re-encrypts the org's rows (keys-jobs.ts).
 * Not while the previous re-encryption is still running or verifying (409), and at most once an
 * hour per org (429): every rotation keeps one more key version alive until its job finishes.
 */
tenantApp.post('/:orgId/keys/rotate', requireOrgRole('tenant_admin'), requireMfa, async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const [job, last] = await c.env.DB.batch<{ status?: string; at?: number | null }>([
    c.env.DB.prepare('SELECT status FROM key_rotation_jobs WHERE org_id = ?').bind(orgId),
    c.env.DB.prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(rotated_at) AS at FROM data_keys WHERE owner_type = 'org' AND owner_id = ?1
         UNION ALL SELECT MAX(started_at) FROM key_rotation_jobs WHERE org_id = ?1)`,
    ).bind(orgId),
  ]);
  const status = job?.results[0]?.status;
  if (status === 'running' || status === 'verifying') fail(409, 'rotation_in_progress');
  const lastAt = Number(last?.results[0]?.at ?? 0);
  if (lastAt && Date.now() - lastAt < ORG_KEY_ROTATION_INTERVAL_MS) fail(429, 'rotation_too_soon');
  const version = await deps().keyRing(c.env).rotateOrgKey(orgId, { by: user.id });
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'org.key_rotated', targetType: 'org', targetId: orgId, details: { version } });
  await auditPlatform(c.env, { actorId: user.id, actorRole: 'user', action: 'org.key_rotated', targetType: 'org', targetId: orgId, details: { version } });
  return c.json({ version });
});

tenantApp.route('/', teamsApp);
tenantApp.route('/', policyApp);
tenantApp.route('/', domainsApp);


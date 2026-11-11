// Hard deletion of an org (D29, D31) and of a user account (D59). No soft delete: rows go,
// and the owner's data key is destroyed so copies in backups become unreadable (D36).
import type { Env } from '../env';
import { auditPlatform } from './audit';
import { deps } from './deps';
import { dropGateSessions, orgInstanceIds, userProfile } from './util';
import { deleteSubscriberByEmail } from '../newsletter/core';

/** Statements on tables another module may not have created yet are tried one by one. */
async function tryRun(env: Env, sql: string, ...binds: unknown[]): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...binds).run();
  } catch (err) {
    console.error(JSON.stringify({ at: 'lifecycle.tryRun', sql, message: (err as Error).message }));
  }
}

/** Every instance first (instance-lifecycle.md "Delete"), then the key, then the rows. */
export async function deleteOrgNow(env: Env, orgId: string, actorId: string): Promise<void> {
  const instanceIds = await orgInstanceIds(env, orgId);
  for (const id of instanceIds) await deps().instances.deleteInstanceNow(env, id, { actorId });

  const members = await env.DB.prepare('SELECT COUNT(*) AS n FROM member WHERE organizationId = ?').bind(orgId).first<{ n: number }>();
  await deps().keyRing(env).destroyKey({ type: 'org', id: orgId });

  const teamIds = 'SELECT id FROM team WHERE organizationId = ?';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM instance_teams WHERE team_id IN (${teamIds})`).bind(orgId),
    env.DB.prepare(`DELETE FROM teamMember WHERE teamId IN (${teamIds})`).bind(orgId),
    env.DB.prepare('DELETE FROM team WHERE organizationId = ?').bind(orgId),
    env.DB.prepare('DELETE FROM invitation WHERE organizationId = ?').bind(orgId),
    env.DB.prepare('DELETE FROM member WHERE organizationId = ?').bind(orgId),
    env.DB.prepare('DELETE FROM org_login_policies WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM org_egress_policies WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM org_domains WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM confirmations WHERE org_id = ? AND used_at IS NULL').bind(orgId),
    // org_settings first: the audit_org trigger lets a deleted org's log go (0003_platform.sql).
    env.DB.prepare('DELETE FROM org_settings WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM audit_org WHERE org_id = ?').bind(orgId),
    env.DB.prepare('DELETE FROM organization WHERE id = ?').bind(orgId),
  ]);
  await tryRun(env, 'DELETE FROM ssoProvider WHERE organizationId = ?', orgId);
  await tryRun(env, 'UPDATE session SET activeOrganizationId = NULL WHERE activeOrganizationId = ?', orgId);

  // security.md: the platform log keeps a metadata record of the deletion (D57: 30 days).
  await auditPlatform(env, {
    actorId,
    actorRole: 'user',
    action: 'org.deleted',
    targetType: 'org',
    targetId: orgId,
    details: { instances: instanceIds.length, members: members?.n ?? 0 },
  });
}

/** D59 erasure. The caller has checked the last-admin and last-superadmin guards. */
export async function purgeUser(env: Env, userId: string, actor: { id: string | null; role: 'user' | 'admin' | 'superadmin' }): Promise<void> {
  const orgs = await env.DB.prepare('SELECT organizationId AS orgId FROM member WHERE userId = ?').bind(userId).all<{ orgId: string }>();
  for (const { orgId } of orgs.results) await dropGateSessions(env, await orgInstanceIds(env, orgId), userId);

  const teams = await env.DB.prepare('SELECT teamId FROM teamMember WHERE userId = ?').bind(userId).all<{ teamId: string }>();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM teamMember WHERE userId = ?').bind(userId),
    ...teams.results.map((t) =>
      env.DB.prepare('UPDATE team SET memberCount = (SELECT COUNT(*) FROM teamMember WHERE teamId = ?1) WHERE id = ?1').bind(t.teamId),
    ),
    env.DB.prepare('DELETE FROM member WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(userId),
    env.DB.prepare('DELETE FROM platform_roles WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM confirmations WHERE user_id = ? AND used_at IS NULL').bind(userId),
  ]);
  await tryRun(env, 'DELETE FROM passkey WHERE userId = ?', userId);
  // D70: the account's address leaves the newsletter too (row and key). Read before the key goes.
  try {
    const email = (await userProfile(env, userId))?.email;
    if (email) await deleteSubscriberByEmail(env, email);
  } catch (err) {
    console.error(JSON.stringify({ at: 'lifecycle.purgeUser.newsletter', userId, message: (err as Error).message }));
  }
  await deps().keyRing(env).destroyKey({ type: 'user', id: userId });
  await env.DB.prepare('DELETE FROM user WHERE id = ?').bind(userId).run();

  await auditPlatform(env, {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'user.deleted',
    targetType: 'user',
    targetId: userId,
    details: { orgs: orgs.results.length },
  });
}

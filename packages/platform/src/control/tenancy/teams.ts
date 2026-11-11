// Teams and team members (D19, D39). Team names are tenant data, encrypted with the org key.
// Losing a team drops the affected gate sessions (D46).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { auditOrg } from './audit';
import { deps } from './deps';
import { requireOrgRole } from './roles';
import { actor, dropGateSessions, fail, field, isoNow, memberRole, orgOwner, parseBody, parseJsonArray, teamInstanceIds, tryDecrypt, userOwner } from './util';

export const teamsApp = new Hono<AppContext>();

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });

async function requireTeam(env: Env, orgId: string, teamId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 FROM team WHERE id = ? AND organizationId = ?').bind(teamId, orgId).first();
  if (!row) fail(404, 'not_found');
}

const teamName = (orgId: string, teamId: string) => field('team', 'name', teamId, orgOwner(orgId));

/** Same key as Better Auth's organization adapter, so its own team calls see our rows. */
async function membershipKey(teamId: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([teamId, userId])));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const syncMemberCount = (env: Env, teamId: string) =>
  env.DB.prepare('UPDATE team SET memberCount = (SELECT COUNT(*) FROM teamMember WHERE teamId = ?1) WHERE id = ?1').bind(teamId);

/**
 * Team names by id, for teams of this org only (ids of other orgs are left out). Exported for
 * the instances list, so tenant users see the names of the teams that grant them access (T1).
 */
export async function teamNamesFor(env: Env, orgId: string, teamIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(teamIds)];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT id, name FROM team WHERE organizationId = ? AND id IN (${chunk.map(() => '?').join(',')})`)
      .bind(orgId, ...chunk)
      .all<{ id: string; name: string }>();
    for (const r of rows.results) out.set(r.id, await tryDecrypt(env, teamName(orgId, r.id), r.name));
  }
  return out;
}

interface TeamRow {
  id: string;
  name: string;
  createdAt: string;
  members: number;
  mine: number;
  instances: string;
}

async function listTeams(env: Env, orgId: string, userId: string, onlyMine: boolean): Promise<TeamRow[]> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, t.createdAt,
            (SELECT COUNT(*) FROM teamMember tm WHERE tm.teamId = t.id) AS members,
            EXISTS (SELECT 1 FROM teamMember tm WHERE tm.teamId = t.id AND tm.userId = ?2) AS mine,
            (SELECT json_group_array(it.instance_id) FROM instance_teams it WHERE it.team_id = t.id) AS instances
     FROM team t WHERE t.organizationId = ?1 ${onlyMine ? 'AND EXISTS (SELECT 1 FROM teamMember tm WHERE tm.teamId = t.id AND tm.userId = ?2)' : ''}
     ORDER BY t.createdAt`,
  )
    .bind(orgId, userId)
    .all<TeamRow>();
  return rows.results;
}

/**
 * Every member sees the org's teams: names, member counts and which are theirs (GitHub/Slack
 * style directory). Instance grants and dates only for tenant admins.
 */
teamsApp.get('/:orgId/teams', requireOrgRole('any'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const isAdmin = (await memberRole(c.env, orgId, user.id)) === 'tenant_admin';
  const teams = [];
  for (const r of await listTeams(c.env, orgId, user.id, false)) {
    const base = { id: r.id, name: await tryDecrypt(c.env, teamName(orgId, r.id), r.name), members: r.members, mine: Boolean(r.mine) };
    teams.push(isAdmin ? { ...base, createdAt: r.createdAt, instanceIds: parseJsonArray(r.instances) } : base);
  }
  return c.json({ teams });
});

/** T15: the caller's own teams, with the instances each one grants them. */
teamsApp.get('/:orgId/teams/mine', requireOrgRole('any'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const teams = [];
  for (const r of await listTeams(c.env, orgId, user.id, true)) {
    teams.push({ id: r.id, name: await tryDecrypt(c.env, teamName(orgId, r.id), r.name), members: r.members, instanceIds: parseJsonArray(r.instances) });
  }
  return c.json({ teams });
});

teamsApp.post('/:orgId/teams', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const { name } = await parseBody(c, nameSchema);
  const id = crypto.randomUUID();
  const enc = await deps().keyRing(c.env).encrypt(teamName(orgId, id), name);
  const now = isoNow();
  await c.env.DB.prepare('INSERT INTO team (id, name, memberCount, organizationId, createdAt, updatedAt) VALUES (?, ?, 0, ?, ?, ?)').bind(id, enc, orgId, now, now).run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'team.created', targetType: 'team', targetId: id, details: { name } });
  return c.json({ id }, 201);
});

teamsApp.patch('/:orgId/teams/:teamId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const { user } = actor(c);
  const { name } = await parseBody(c, nameSchema);
  await requireTeam(c.env, orgId, teamId);
  const enc = await deps().keyRing(c.env).encrypt(teamName(orgId, teamId), name);
  await c.env.DB.prepare('UPDATE team SET name = ?, updatedAt = ? WHERE id = ?').bind(enc, isoNow(), teamId).run();
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'team.renamed', targetType: 'team', targetId: teamId, details: { name } });
  return c.json({ ok: true });
});

/** Instances (not being deleted) whose only team this is: they'd be left without one (D71). */
async function soleTeamInstances(env: Env, teamId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM instance_teams it JOIN instances i ON i.id = it.instance_id
      WHERE it.team_id = ?1 AND i.status <> 'deleting'
        AND NOT EXISTS (SELECT 1 FROM instance_teams o WHERE o.instance_id = it.instance_id AND o.team_id <> ?1)`,
  )
    .bind(teamId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Refused while it is the only team of an instance (D71): move those instances or delete them first. */
teamsApp.delete('/:orgId/teams/:teamId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const { user } = actor(c);
  await requireTeam(c.env, orgId, teamId);
  const sole = await soleTeamInstances(c.env, teamId);
  if (sole) return c.json({ error: 'team_has_instances', instances: sole }, 409);
  const instanceIds = await teamInstanceIds(c.env, teamId);
  const members = await c.env.DB.prepare('SELECT userId FROM teamMember WHERE teamId = ?').bind(teamId).all<{ userId: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM instance_teams WHERE team_id = ?').bind(teamId),
    c.env.DB.prepare('DELETE FROM teamMember WHERE teamId = ?').bind(teamId),
    c.env.DB.prepare('DELETE FROM team WHERE id = ?').bind(teamId),
  ]);
  for (const m of members.results) await dropGateSessions(c.env, instanceIds, m.userId);
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'team.deleted', targetType: 'team', targetId: teamId, details: { members: members.results.length, instances: instanceIds.length } });
  return c.json({ ok: true });
});

teamsApp.get('/:orgId/teams/:teamId/members', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  await requireTeam(c.env, orgId, teamId);
  const rows = await c.env.DB.prepare(
    'SELECT tm.userId, tm.createdAt, u.name, u.email FROM teamMember tm JOIN user u ON u.id = tm.userId WHERE tm.teamId = ? ORDER BY tm.createdAt',
  )
    .bind(teamId)
    .all<{ userId: string; createdAt: string; name: string; email: string }>();
  const members = [];
  for (const r of rows.results) {
    members.push({
      userId: r.userId,
      addedAt: r.createdAt,
      name: await tryDecrypt(c.env, field('user', 'name', r.userId, userOwner(r.userId)), r.name),
      email: await tryDecrypt(c.env, field('user', 'email', r.userId, userOwner(r.userId)), r.email),
    });
  }
  return c.json({ members });
});

teamsApp.post('/:orgId/teams/:teamId/members', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const { user } = actor(c);
  const { userId } = await parseBody(c, z.object({ userId: z.string().min(1) }));
  await requireTeam(c.env, orgId, teamId);
  if (!(await memberRole(c.env, orgId, userId))) fail(404, 'member_not_found');
  const exists = await c.env.DB.prepare('SELECT 1 FROM teamMember WHERE teamId = ? AND userId = ?').bind(teamId, userId).first();
  if (exists) fail(409, 'already_member');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO teamMember (id, teamId, userId, membershipKey, createdAt) VALUES (?, ?, ?, ?, ?)').bind(
      crypto.randomUUID(),
      teamId,
      userId,
      await membershipKey(teamId, userId),
      isoNow(),
    ),
    syncMemberCount(c.env, teamId),
  ]);
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'team.member_added', targetType: 'team', targetId: teamId, details: { userId } });
  return c.json({ ok: true }, 201);
});

teamsApp.delete('/:orgId/teams/:teamId/members/:userId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const userId = c.req.param('userId');
  const { user } = actor(c);
  await requireTeam(c.env, orgId, teamId);
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM teamMember WHERE teamId = ? AND userId = ?').bind(teamId, userId),
    syncMemberCount(c.env, teamId),
  ]);
  if (!res?.meta.changes) fail(404, 'not_found');
  await dropGateSessions(c.env, await teamInstanceIds(c.env, teamId), userId); // D46
  await auditOrg(c.env, orgId, { actorId: user.id, actorScope: 'tenant', action: 'team.member_removed', targetType: 'team', targetId: teamId, details: { userId } });
  return c.json({ ok: true });
});

// ---- per-team instance grants (T10) -----------------------------------------------------------
// One row each, so a team page can toggle a grant without read-modify-writing the instance's
// whole team list (PUT /instances/:id/teams). Audited as instance.teams_changed, like that route.

async function requireInstance(env: Env, orgId: string, instanceId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 FROM instances WHERE id = ? AND org_id = ?').bind(instanceId, orgId).first();
  if (!row) fail(404, 'instance_not_found');
}

teamsApp.post('/:orgId/teams/:teamId/instances/:instanceId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const instanceId = c.req.param('instanceId');
  const { user } = actor(c);
  await requireTeam(c.env, orgId, teamId);
  await requireInstance(c.env, orgId, instanceId);
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO instance_teams (instance_id, team_id) VALUES (?, ?)').bind(instanceId, teamId).run();
  const changed = Boolean(res.meta.changes);
  if (changed) {
    await auditOrg(c.env, orgId, {
      actorId: user.id, actorScope: 'tenant', action: 'instance.teams_changed', targetType: 'instance', targetId: instanceId, details: { added: [teamId], removed: [] },
    });
  }
  return c.json({ ok: true, changed });
});

/**
 * Members of the team with no other team granting this instance lose access: sessions dropped
 * (D46). Refused for the instance's last team (D71).
 */
teamsApp.delete('/:orgId/teams/:teamId/instances/:instanceId', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const teamId = c.req.param('teamId');
  const instanceId = c.req.param('instanceId');
  const { user } = actor(c);
  await requireTeam(c.env, orgId, teamId);
  await requireInstance(c.env, orgId, instanceId);
  // One statement, so two concurrent removals can't leave the instance with no team.
  const res = await c.env.DB.prepare(
    `DELETE FROM instance_teams WHERE instance_id = ?1 AND team_id = ?2
       AND EXISTS (SELECT 1 FROM instance_teams o WHERE o.instance_id = ?1 AND o.team_id <> ?2)`,
  )
    .bind(instanceId, teamId)
    .run();
  if (!res.meta.changes) {
    const granted = await c.env.DB.prepare('SELECT 1 FROM instance_teams WHERE instance_id = ? AND team_id = ?').bind(instanceId, teamId).first();
    if (granted) fail(409, 'last_team');
    return c.json({ ok: true, changed: false, droppedUsers: 0 });
  }
  // Computed after the delete, so a grant added concurrently through another team still counts.
  const lost = await c.env.DB.prepare(
    `SELECT DISTINCT userId FROM teamMember WHERE teamId = ?1 AND userId NOT IN (
       SELECT tm.userId FROM teamMember tm JOIN instance_teams it ON it.team_id = tm.teamId WHERE it.instance_id = ?2)`,
  )
    .bind(teamId, instanceId)
    .all<{ userId: string }>();
  for (const r of lost.results) await dropGateSessions(c.env, [instanceId], r.userId);
  await auditOrg(c.env, orgId, {
    actorId: user.id, actorScope: 'tenant', action: 'instance.teams_changed', targetType: 'instance', targetId: instanceId, details: { added: [], removed: [teamId] },
  });
  return c.json({ ok: true, changed: true, droppedUsers: lost.results.length });
});

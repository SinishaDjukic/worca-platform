// Tenant console API for instances, mounted at /api/orgs (index.ts), and the heartbeat endpoint.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { gate } from '../gate-client';
import {
  auditOrgSafe,
  changeRemoteAccess,
  changeSize,
  decryptDisplayName,
  deleteInstanceNow,
  encryptDisplayName,
  hostFor,
  instanceUrl,
  reserveSlugs,
  startOp,
  startRefresh,
  startUpgrade,
  AUTO_UPDATE_MODES,
  autoUpdateColumns,
  autoUpdateModeOf,
  type InstanceRow,
} from './api';
import { deps, type ConfirmHandler } from './deps';
import { compareVersions, deployableVersions, isPublishedVersion, isRc, imageSources, isVersion, latestWorcaVersion, needsRefresh, orgHasReleaseCandidates, releaseCandidates, withdrawnReleases, type Withdrawal } from './images';
import { latestOps, tenantError, tenantOpView, type OpRow } from './progress';
import { computeView } from './compute-facts';
import { EGRESS_MODES, isLoosening, normalizePolicy, platformEgressHosts, type EgressPolicy, type PolicyProblem } from './egress';
import { changeInstanceEgress, changeOrgEgress, inheritCounts, instanceEgress, readOrgEgress } from './egress-api';
import { githubNeedsCheck, gitNeedsMfa, gitView, mergeGitInput, PUSH_AS, type GitInput } from './git';
import { changeInstanceGit, checkGithub, GithubCheckError, readGit } from './git-api';
import { orgSummary } from './summary';
import { computeSizes, sizeView } from './sizes';
import { computeInfo, instanceSettings } from '../providers';
import { SettingsError, storeValues, validateSettings } from '../providers/settings';
import { confirmationSent } from '../tenancy/confirmations';
import { getOrgPolicy } from '../tenancy/policy';
import { requireMfa } from '../tenancy/roles';
import { teamNamesFor } from '../tenancy/teams';
import { LOGIN_METHODS } from '../tenancy/util';

import { featureOn } from '../features';

export { heartbeatApp } from './heartbeat';

// ---- tiers (D33) ----

export interface TierLimits {
  /** null: no limit (tiers off, 2.4). */
  instancesPerOrg: number | null;
  volumeGb: number;
  /** D78: the compute sizes the org may pick (ids, sizes.ts order) and the one a new instance gets. */
  sizes: string[];
  defaultSize: string;
}
/** Without a tier: one instance on the provider's default size. */
export function freeTier(env: Pick<Env, 'COMPUTE_PROVIDER'>): TierLimits {
  const dflt = computeSizes(env).defaultId;
  return { instancesPerOrg: 1, volumeGb: 10, sizes: [dflt], defaultSize: dflt };
}

type TierRow = { instancesPerOrg: number; volumeGb: number; sizes: string | null; defaultSize: string | null };
function tierLimits(env: Pick<Env, 'COMPUTE_PROVIDER'>, row: TierRow): TierLimits {
  const sizes = computeSizes(env).parseTier(row.sizes);
  return {
    instancesPerOrg: row.instancesPerOrg,
    volumeGb: row.volumeGb,
    sizes,
    defaultSize: row.defaultSize && sizes.includes(row.defaultSize) ? row.defaultSize : sizes[0]!,
  };
}

/**
 * With the tiers module off (2.4): one unlimited tier. Any number of instances, every size the
 * provider offers, its default size, and the free tier's volume (migration 0003).
 */
export function unlimitedTier(env: Pick<Env, 'COMPUTE_PROVIDER'>): TierLimits {
  const table = computeSizes(env);
  return { instancesPerOrg: null, volumeGb: 10, sizes: table.all.map((s) => s.id), defaultSize: table.defaultId };
}

/** Binds a limit into SQL: no limit is a count no org reaches. */
export const sqlLimit = (limit: number | null): number => limit ?? 2_147_483_647;

/** The org's tier from org_settings, else the platform default tier, else the free tier; the unlimited tier while tiers are off. */
export async function tierFor(env: Env, orgId: string): Promise<TierLimits> {
  if (!featureOn(env, 'tiers')) return unlimitedTier(env);
  const cols = `instances_per_org AS instancesPerOrg, volume_gb AS volumeGb, sizes, default_size AS defaultSize`;
  try {
    const own = await env.DB.prepare(`SELECT ${cols} FROM tiers WHERE id = (SELECT tier FROM org_settings WHERE org_id = ?)`)
      .bind(orgId)
      .first<TierRow>();
    if (own) return tierLimits(env, own);
    const dflt = await env.DB.prepare(
      `SELECT ${cols} FROM tiers WHERE id = COALESCE((SELECT value FROM platform_settings WHERE key = 'default_tier'), 'free')`,
    ).first<TierRow>();
    return dflt ? tierLimits(env, dflt) : freeTier(env);
  } catch {
    return freeTier(env); // tenancy tables not migrated yet
  }
}

// ---- helpers ----

const session: MiddlewareHandler<AppContext> = (c, next) => deps().requireSession(c, next);
const member: MiddlewareHandler<AppContext> = (c, next) => deps().requireOrgRole()(c, next);
const admin: MiddlewareHandler<AppContext> = (c, next) => deps().requireOrgRole('tenant_admin')(c, next);

const NameSchema = z.string().trim().min(1).max(100);
const TeamIdsSchema = z.array(z.string().min(1).max(64)).max(50);
// T8: the instance's login policy (D23, narrowing only) can be set at creation. Same validation
// as PUT /:orgId/instances/:id/policy (tenancy/policy-routes.ts, which exports no helper).
const MethodsSchema = z.array(z.enum(LOGIN_METHODS)).max(LOGIN_METHODS.length).transform((m) => [...new Set(m)]);
// D71: an instance is created within a team. `teamId` is that team; `teamIds` (older clients) are
// also assigned. Neither given is `team_required`, checked after parsing so it isn't `invalid_body`.
const CreateSchema = z.object({
  name: NameSchema,
  teamId: z.string().min(1).max(64).optional(),
  teamIds: TeamIdsSchema.optional(),
  policy: z.object({ requiredMethods: MethodsSchema }).optional(),
  // D78: a compute size the org's tier allows; the tier's default when left out.
  size: z.string().min(1).max(40).optional(),
  // The compute provider's instance settings (docs/providers.md "Settings"), checked against its declaration.
  providerSettings: z.record(z.string(), z.unknown()).optional(),
});
const RenameSchema = z.object({ name: NameSchema });
const TeamsSchema = z.object({ teamIds: TeamIdsSchema });
const UpgradeSchema = z.object({ version: z.string().min(1).max(64).optional() });
const AutoUpdateSchema = z.object({ mode: z.enum(AUTO_UPDATE_MODES) });
const RemoteAccessSchema = z.object({ terminal: z.boolean(), actions: z.boolean() }).strict();
const SizeSchema = z.object({ size: z.string().min(1).max(40) }).strict();
// D73: entries are checked one by one after parsing (normalizePolicy), so a bad one is named.
const HostListSchema = z.array(z.string().max(300)).max(1000);
const EgressPolicySchema = z.object({ mode: z.enum(EGRESS_MODES), allow: HostListSchema.optional(), deny: HostListSchema.optional() }).strict();
const OrgEgressSchema = z.object({ policy: EgressPolicySchema, version: z.number().int().min(0) }).strict();
const InstanceEgressSchema = z.object({ policy: EgressPolicySchema.nullable(), version: z.number().int().min(0) }).strict();
// D79: values are checked one by one after parsing (git.ts mergeGitInput), so a bad one is named.
const Secret = z.string().max(12_000).optional();
const GitSchema = z
  .object({
    version: z.number().int().min(0),
    github: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('app'),
          appId: z.string().max(40),
          privateKey: Secret,
          installationId: z.string().max(40).nullable().optional(),
          signIn: z.object({ clientSecret: Secret }).strict().nullable().optional(),
        }).strict(),
        z.object({ kind: z.literal('token'), token: Secret }).strict(),
      ])
      .nullable()
      .optional(),
    azure: z.object({ token: Secret }).strict().nullable().optional(),
    bitbucket: z.object({ token: Secret, email: z.string().max(300).nullable().optional() }).strict().nullable().optional(),
    identity: z.object({ name: z.string().max(300), email: z.string().max(300) }).strict().nullable().optional(),
    cloneAllow: z.array(z.string().max(400)).max(500).optional(),
    pushAs: z.enum(PUSH_AS).optional(),
  })
  .strict();
// `confirmName` like every other destructive route; `name` is the older spelling, still accepted.
const DeleteSchema = z
  .object({ confirmName: z.string().optional(), name: z.string().optional() })
  .refine((b) => b.confirmName !== undefined || b.name !== undefined);

async function body<T>(c: Context<AppContext>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid_body' });
  return parsed.data;
}

function userId(c: Context<AppContext>): string {
  const u = c.get('user');
  if (!u) throw new HTTPException(401, { message: 'unauthorized' });
  return u.id;
}

async function isOrgAdmin(env: Env, orgId: string, uid: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT role FROM member WHERE organizationId = ? AND userId = ?`).bind(orgId, uid).first<{ role: string }>();
  return !!row && row.role.split(',').map((r) => r.trim()).includes('tenant_admin');
}

async function loadOwned(env: Env, orgId: string, id: string): Promise<InstanceRow> {
  const row = await env.DB.prepare(`SELECT * FROM instances WHERE id = ? AND org_id = ?`).bind(id, orgId).first<InstanceRow>();
  if (!row) throw new HTTPException(404, { message: 'not_found' });
  return row;
}

/** Ids of the given teams that belong to the org; 400 `unknown_team` (or the given refusal) if any doesn't. */
async function checkTeams(
  env: Env,
  orgId: string,
  teamIds: string[],
  missing: { status: 400 | 404; code: string } = { status: 400, code: 'unknown_team' },
): Promise<string[]> {
  const ids = [...new Set(teamIds)];
  if (!ids.length) return ids;
  const { results } = await env.DB.prepare(
    `SELECT id FROM team WHERE organizationId = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(orgId, ...ids)
    .all<{ id: string }>();
  if (results.length !== ids.length) throw new HTTPException(missing.status, { message: missing.code });
  return ids;
}
const TEAM_NOT_FOUND = { status: 404, code: 'team_not_found' } as const;

interface BeatRow {
  instance_id: string;
  pipelines: string;
  suspendable: number;
  next_scheduled_at: number | null;
}
interface Extras {
  teams: Map<string, string[]>;
  teamNames: Map<string, string | null>;
  beats: Map<string, BeatRow>;
  ops: Map<string, OpRow>;
  /** D77: withdrawn releases, by version. */
  withdrawn: Map<string, Withdrawal>;
}

/** Team grants, team names (T1), latest heartbeats and latest operations (T8) of org instances. */
async function extrasFor(env: Env, orgId: string, ids: string[]): Promise<Extras> {
  const teams = new Map<string, string[]>();
  const beats: Extras['beats'] = new Map();
  if (!ids.length) return { teams, teamNames: new Map(), beats, ops: new Map(), withdrawn: new Map() };
  const ph = ids.map(() => '?').join(',');
  const [t, b] = await env.DB.batch([
    env.DB.prepare(`SELECT instance_id, team_id FROM instance_teams WHERE instance_id IN (${ph})`).bind(...ids),
    env.DB.prepare(`SELECT * FROM heartbeats WHERE instance_id IN (${ph})`).bind(...ids),
  ]);
  for (const r of (t?.results ?? []) as { instance_id: string; team_id: string }[]) {
    teams.set(r.instance_id, [...(teams.get(r.instance_id) ?? []), r.team_id]);
  }
  for (const r of (b?.results ?? []) as BeatRow[]) {
    beats.set(r.instance_id, r);
  }
  const teamNames = await teamNamesFor(env, orgId, [...teams.values()].flat());
  return { teams, teamNames, beats, ops: await latestOps(env, ids), withdrawn: await withdrawnReleases(env) };
}

async function view(env: Env, row: InstanceRow, extras: Extras) {
  const host = hostFor(env, row.slug);
  const keyHost = hostFor(env, row.key_slug);
  const beat = extras.beats.get(row.id);
  const op = extras.ops.get(row.id);
  const teamIds = extras.teams.get(row.id) ?? [];
  return {
    id: row.id,
    orgId: row.org_id,
    name: await decryptDisplayName(env, row),
    status: row.status,
    health: row.health,
    healthSince: row.health_since,
    version: row.worca_version,
    availableVersion: row.available_version,
    upgradingTo: row.target_version,
    // D77: the platform withdrew the version this instance runs; the reason is the staff's.
    versionWithdrawn: (row.worca_version && extras.withdrawn.get(row.worca_version)) || null,
    // D76: a service runs an older image than its version deploys today (a newer cloudflared pin):
    // the upgrade route refreshes it at the same version, and the cron does too.
    componentsOutdated: needsRefresh(row, imageSources(env)),
    // D80: pinned to a release candidate; automatic updates leave it alone until an admin moves it.
    releaseCandidate: isRc(row.worca_version),
    // D26 as amended, D75: 'micro' installs x.y.Z releases while idle, 'minor' also x.Y.0 (auto-update.ts).
    autoUpdate: autoUpdateModeOf(row),
    autoUpdateFailedVersion: row.auto_update_failed_version ?? null,
    // D72: terminal and actions in worca, off unless a tenant admin turned them on. `pending`: saved
    // but not yet applied (applies on the next start, or the reconfigure failed).
    remoteAccess: { terminal: !!row.terminal_remote, actions: !!row.actions_remote, pending: !!row.remote_pending },
    host,
    keyHost,
    url: instanceUrl(env, host),
    keyUrl: instanceUrl(env, keyHost),
    teamIds,
    teams: teamIds.filter((id) => extras.teamNames.has(id)).map((id) => ({ id, name: extras.teamNames.get(id) ?? null })),
    lastHeartbeatAt: row.last_heartbeat_at,
    pipelines: beat ? (JSON.parse(beat.pipelines) as Record<string, number>) : null,
    suspendable: beat ? !!beat.suspendable : null,
    nextScheduledAt: beat?.next_scheduled_at ?? null,
    stoppedReason: row.stopped_reason,
    ...tenantError(row.last_error),
    createdAt: row.created_at,
    // Region and resources as the compute provider last reported them; null until first checked.
    compute: computeView(computeInfo(env), row),
    // D78: the compute size; `pending`: saved but not yet applied (next start, or a failed reconfigure).
    size: { ...sizeView(computeSizes(env).of(row)), pending: !!row.size_pending },
    // D79: git credentials set from the console; the details are at …/git.
    // `pending` only for settings an admin saved (git_version 0 is the platform's default, D79).
    git: { configured: !!row.git_settings, pending: !!row.git_pending && !!row.git_version },
    // The compute provider's instance settings: what the provider gets (defaults filled in); the
    // fields are in the org summary (instances.providerFields). Secret fields hold names only.
    providerSettings: instanceSettings(env, row.provider_settings),
    op: op ? tenantOpView(op) : null,
  };
}

/** Rows the caller may see: tenant admins all, tenant users those their teams grant (D19). */
async function visibleRows(env: Env, orgId: string, uid: string, instanceId?: string): Promise<InstanceRow[]> {
  const one = instanceId ? ' AND i.id = ?' : '';
  const binds = instanceId ? [orgId, instanceId] : [orgId];
  if (await isOrgAdmin(env, orgId, uid)) {
    const { results } = await env.DB.prepare(`SELECT i.* FROM instances i WHERE i.org_id = ?${one} ORDER BY i.created_at`)
      .bind(...binds)
      .all<InstanceRow>();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT i.* FROM instances i
       JOIN instance_teams it ON it.instance_id = i.id
       JOIN teamMember tm ON tm.teamId = it.team_id
      WHERE i.org_id = ?${one} AND tm.userId = ? ORDER BY i.created_at`,
  )
    .bind(...binds, uid)
    .all<InstanceRow>();
  return results;
}

// ---- routes ----

export const instancesApp = new Hono<AppContext>();
instancesApp.use('/:orgId/instances', session);
instancesApp.use('/:orgId/instances/*', session);

instancesApp.post('/:orgId/instances', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const input = await body(c, CreateSchema);
  const wanted = [...(input.teamId ? [input.teamId] : []), ...(input.teamIds ?? [])];
  if (!wanted.length) throw new HTTPException(400, { message: 'team_required' }); // D71
  const teamIds = await checkTeams(c.env, orgId, wanted, TEAM_NOT_FOUND);
  const requiredMethods = input.policy?.requiredMethods ?? [];
  if (requiredMethods.length) {
    const org = await getOrgPolicy(c.env, orgId);
    if (org.allowedMethods.length > 0 && requiredMethods.some((m) => !org.allowedMethods.includes(m))) {
      throw new HTTPException(400, { message: 'not_narrowing' }); // D23
    }
  }
  const tier = await tierFor(c.env, orgId);
  // D78: the size must be one the tier allows (unknown sizes are never allowed).
  const size = computeSizes(c.env).byId(input.size ?? tier.defaultSize);
  if (!size || !tier.sizes.includes(size.id)) throw new HTTPException(400, { message: 'size_not_allowed' });
  const settings = checkInstanceSettings(c.env, input.providerSettings);
  if (settings instanceof Response) return settings;
  const id = crypto.randomUUID();
  const { slug, keySlug } = await reserveSlugs(c.env);
  const name = await encryptDisplayName(c.env, orgId, id, input.name);
  const now = Date.now();
  // One batch (a transaction): the row only if the tier has room (one statement, so two concurrent
  // creates can't both pass the limit, D33) and its teams still exist, then its teams (D71), so no
  // instance is ever without a team, even for a moment.
  const teamPh = teamIds.map(() => '?').join(',');
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO instances (id, org_id, slug, key_slug, display_name, status, cpu, memory_mb, volume_gb, created_at, updated_at, auto_update, compute_size, provider_settings)
       SELECT ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, 'micro', ?, ?
        WHERE (SELECT count(*) FROM instances WHERE org_id = ? AND status <> 'deleting') < ?
          AND (SELECT count(*) FROM team WHERE organizationId = ? AND id IN (${teamPh})) = ?`,
    ).bind(id, orgId, slug, keySlug, name, size.vcpu, size.memoryMb, tier.volumeGb, now, now, size.id, Object.keys(settings).length ? storeValues(c.env.COMPUTE_PROVIDER, settings) : null, orgId, sqlLimit(tier.instancesPerOrg), orgId, ...teamIds, teamIds.length),
    c.env.DB.prepare(
      `INSERT INTO instance_teams (instance_id, team_id)
       SELECT ?, id FROM team WHERE organizationId = ? AND id IN (${teamPh}) AND EXISTS (SELECT 1 FROM instances WHERE id = ?)`,
    ).bind(id, orgId, ...teamIds, id),
  ]);
  if (!res?.meta.changes) {
    await checkTeams(c.env, orgId, teamIds, TEAM_NOT_FOUND); // a team was deleted meanwhile
    throw new HTTPException(403, { message: 'tier_limit' });
  }
  if (requiredMethods.length) {
    // No gate sessions exist yet, so unlike the policy route there are none to drop.
    await c.env.DB.prepare(`INSERT INTO instance_login_policies (instance_id, required_methods, updated_at) VALUES (?, ?, ?)`)
      .bind(id, JSON.stringify(requiredMethods), now)
      .run();
  }
  await startOp(c.env, { op: 'create', instanceId: id, actorId });
  await auditOrgSafe(c.env, orgId, {
    actorId, actorScope: 'tenant', action: 'instance.create_started', targetType: 'instance', targetId: id, details: { slug, teamIds, size: size.id },
  });
  if (requiredMethods.length) {
    await auditOrgSafe(c.env, orgId, {
      actorId, actorScope: 'tenant', action: 'instance.policy_updated', targetType: 'instance', targetId: id, details: { requiredMethods },
    });
  }
  const row = (await c.env.DB.prepare(`SELECT * FROM instances WHERE id = ?`).bind(id).first<InstanceRow>())!;
  return c.json(await view(c.env, row, await extrasFor(c.env, orgId, [id])), 201);
});

/** T4: the tenant console overview for admins (summary.ts). */
instancesApp.get('/:orgId/summary', session, admin, async (c) => {
  return c.json(await orgSummary(c.env, c.req.param('orgId')));
});

instancesApp.get('/:orgId/instances', member, async (c) => {
  const orgId = c.req.param('orgId');
  const rows = await visibleRows(c.env, orgId, userId(c));
  const extras = await extrasFor(c.env, orgId, rows.map((r) => r.id));
  return c.json({ instances: await Promise.all(rows.map((r) => view(c.env, r, extras))) });
});

instancesApp.get('/:orgId/instances/:id', member, async (c) => {
  const orgId = c.req.param('orgId');
  const [row] = await visibleRows(c.env, orgId, userId(c), c.req.param('id'));
  if (!row) throw new HTTPException(404, { message: 'not_found' });
  return c.json(await view(c.env, row, await extrasFor(c.env, orgId, [row.id])));
});

instancesApp.patch('/:orgId/instances/:id', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const { name } = await body(c, RenameSchema);
  await c.env.DB.prepare(`UPDATE instances SET display_name = ?, updated_at = ? WHERE id = ?`)
    .bind(await encryptDisplayName(c.env, orgId, row.id, name), Date.now(), row.id)
    .run();
  await auditOrgSafe(c.env, orgId, { actorId, actorScope: 'tenant', action: 'instance.renamed', targetType: 'instance', targetId: row.id });
  return c.json({ ok: true });
});

/** Checked instance provider settings to store, or the 400 answer naming each problem. */
function checkInstanceSettings(env: Env, input: unknown) {
  try {
    return validateSettings(computeInfo(env).settings?.instance, input);
  } catch (err) {
    if (err instanceof SettingsError) return Response.json({ error: 'invalid_provider_settings', problems: err.problems }, { status: 400 });
    throw err;
  }
}

/**
 * Replaces the instance's provider settings (docs/providers.md "Settings"). Stored now; the
 * provider gets them with its next call for this instance (the next operation). Audited with the
 * keys only.
 */
instancesApp.put('/:orgId/instances/:id/provider-settings', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  if (row.status === 'deleting') throw new HTTPException(409, { message: 'instance_busy' });
  const input = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
  const values = checkInstanceSettings(c.env, input?.values);
  if (values instanceof Response) return values;
  await c.env.DB.prepare(`UPDATE instances SET provider_settings = ?, updated_at = ? WHERE id = ?`)
    .bind(storeValues(c.env.COMPUTE_PROVIDER, values), Date.now(), row.id)
    .run();
  await auditOrgSafe(c.env, orgId, {
    actorId: userId(c), actorScope: 'tenant', action: 'instance.provider_settings_set', targetType: 'instance', targetId: row.id,
    details: { keys: Object.keys(values).sort().join('.') },
  });
  return c.json({ ok: true, providerSettings: instanceSettings(c.env, storeValues(c.env.COMPUTE_PROVIDER, values)) });
});

/** Replaces the instance's teams (at least one, D71); users who lose access have their gate sessions dropped (D46). */
instancesApp.put('/:orgId/instances/:id/teams', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const teamIds = await checkTeams(c.env, orgId, (await body(c, TeamsSchema)).teamIds);
  if (!teamIds.length) throw new HTTPException(409, { message: 'last_team' }); // D71: assign another team first
  const { results: current } = await c.env.DB.prepare(`SELECT team_id FROM instance_teams WHERE instance_id = ?`)
    .bind(row.id)
    .all<{ team_id: string }>();
  const removed = current.map((r) => r.team_id).filter((t) => !teamIds.includes(t));
  const added = teamIds.filter((t) => !current.some((r) => r.team_id === t));
  const lost = await usersLosingAccess(c.env, removed, teamIds);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM instance_teams WHERE instance_id = ?`).bind(row.id),
    ...teamIds.map((t) => c.env.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(row.id, t)),
  ]);
  for (const uid of lost) await gate(c.env).dropSessions(row.id, { userId: uid });
  await auditOrgSafe(c.env, orgId, {
    actorId, actorScope: 'tenant', action: 'instance.teams_changed', targetType: 'instance', targetId: row.id, details: { added, removed },
  });
  return c.json({ teamIds, droppedUsers: lost.length });
});

/** Members of the removed teams who aren't also in one of the teams that remain. */
async function usersLosingAccess(env: Env, removed: string[], kept: string[]): Promise<string[]> {
  if (!removed.length) return [];
  const keptClause = kept.length ? ` AND userId NOT IN (SELECT userId FROM teamMember WHERE teamId IN (${kept.map(() => '?').join(',')}))` : '';
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT userId FROM teamMember WHERE teamId IN (${removed.map(() => '?').join(',')})${keptClause}`,
  )
    .bind(...removed, ...kept)
    .all<{ userId: string }>();
  return results.map((r) => r.userId);
}

type VersionDirection = 'upgrade' | 'downgrade' | 'current' | 'refresh';
/**
 * Moving from `current` to `target`: older targets are downgrades; an unknown current counts as an
 * upgrade. The current version itself is a refresh while its components are out of date (D76).
 */
function directionOf(current: string | null, target: string, outdated = false): VersionDirection {
  if (current === target) return outdated ? 'refresh' : 'current';
  return isVersion(current) && compareVersions(target, current) < 0 ? 'downgrade' : 'upgrade';
}

/**
 * The versions a tenant admin may move this instance to (D26), newest first: published releases
 * and the latest, never unpublished ones or ones older than MIN_HOSTED_WORCA_VERSION. With release
 * candidates on for the org (D80), also the candidates of releases not out yet, marked `rc`.
 */
instancesApp.get('/:orgId/instances/:id/versions', admin, async (c) => {
  const row = await loadOwned(c.env, c.req.param('orgId'), c.req.param('id'));
  const current = row.worca_version;
  const rc = await orgHasReleaseCandidates(c.env, row.org_id);
  const { latest, versions } = await deployableVersions(c.env, row.available_version, { rc });
  return c.json({
    current,
    latest,
    releaseCandidates: rc,
    versions: versions.map((v) => ({
      version: v.version,
      latest: v.version === latest,
      current: v.version === current,
      rc: !!v.rc,
      publishedAt: v.publishedAt,
      direction: directionOf(current, v.version, needsRefresh(row, imageSources(c.env))),
    })),
  });
});

/**
 * D26: a tenant admin starts an upgrade here (the only other start is the automatic micro update,
 * auto-update.ts). Any published version may be chosen; one older than the running version is a
 * downgrade (to step back from a bad release), audited as such; automatic updates then skip the
 * version left until a newer micro is published (api.ts startUpgrade).
 */
instancesApp.post('/:orgId/instances/:id/upgrade', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const input = await body(c, UpgradeSchema);
  const target = input.version ?? row.available_version ?? (await latestWorcaVersion(c.env));
  if (!isVersion(target)) throw new HTTPException(400, { message: 'invalid_version' });
  // D80: a release candidate is pinned by hand, only in an org with release candidates on and only
  // one of a release not out yet. The candidate an instance runs can still be refreshed (D76).
  if (isRc(target) && target !== row.worca_version) {
    if (!(await orgHasReleaseCandidates(c.env, orgId))) throw new HTTPException(403, { message: 'release_candidates_off' });
    if (!(await releaseCandidates(c.env)).some((v) => v.version === target)) throw new HTTPException(400, { message: 'unknown_version' });
  }
  if (!(await isPublishedVersion(c.env, target, row.available_version, { rc: true }))) throw new HTTPException(400, { message: 'unknown_version' });
  if (target === row.worca_version) {
    // D76: the same version again redeploys only what is out of date (cloudflared), when anything is.
    if (!needsRefresh(row, imageSources(c.env))) throw new HTTPException(409, { message: 'already_on_version' });
    if (!(await startRefresh(c.env, row, { actorId, actorScope: 'tenant' }))) throw new HTTPException(409, { message: 'instance_not_running' });
    return c.json({ ok: true, status: 'running', refreshing: true, version: target }, 202);
  }
  const details = { direction: directionOf(row.worca_version, target) };
  if (!(await startUpgrade(c.env, row, target, { actorId, actorScope: 'tenant', details }))) {
    throw new HTTPException(409, { message: 'instance_not_running' });
  }
  return c.json({ ok: true, status: 'upgrading', version: target }, 202);
});

/**
 * D26 as amended, D75: which releases the cron installs while the instance is idle: 'micro' (x.y.Z),
 * 'minor' (also x.Y.0) or 'off'. New instances start with 'micro', instances from before migration
 * 0020 with 'off'; 'minor' is only ever chosen here.
 */
instancesApp.put('/:orgId/instances/:id/auto-update', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const { mode } = await body(c, AutoUpdateSchema);
  const from = autoUpdateModeOf(row);
  if (mode !== from) {
    const cols = autoUpdateColumns(mode);
    await c.env.DB.prepare(`UPDATE instances SET auto_update = ?, auto_update_minor = ?, updated_at = ? WHERE id = ?`)
      .bind(cols.auto_update, cols.auto_update_minor, Date.now(), row.id)
      .run();
    await auditOrgSafe(c.env, orgId, {
      actorId, actorScope: 'tenant', action: 'instance.auto_update_set', targetType: 'instance', targetId: row.id,
      details: { mode, from },
    });
  }
  return c.json({ ok: true, autoUpdate: mode });
});

/**
 * D72: turns worca's terminal and actions on or off for this instance. Either one gives everyone on
 * the instance a shell or commands running as the worca server, so only tenant admins change it
 * (platform roles never reach in, D15), and turning one on needs an MFA session (D24); turning off
 * never does. A running instance restarts worca (`reconfigure`, result 'applying'); a suspended
 * or stopped one only stores the values for its next start ('saved').
 */
instancesApp.post('/:orgId/instances/:id/remote-access', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const input = await body(c, RemoteAccessSchema);
  const enabling = (input.terminal && !row.terminal_remote) || (input.actions && !row.actions_remote);
  if (enabling && !c.get('session')?.mfa) throw new HTTPException(403, { message: 'mfa_required' });
  const result = await changeRemoteAccess(c.env, row, input, actorId);
  // Always 200, `result` says what happened: the console's protected-action helper reads a 202
  // as "check your email" (an emailed confirmation), which this route never sends.
  return c.json({ ok: true, result, remoteAccess: { terminal: input.terminal, actions: input.actions } });
});

/**
 * D78: moves this instance to another compute size the org's tier allows. Only tenant admins. A
 * running instance restarts worca with the new ceiling and parallelism (`reconfigure`, result
 * 'applying'); a suspended or stopped one keeps it for its next start ('saved'). An instance on a
 * size its tier no longer allows (the org moved down) keeps it until moved, and can always move to
 * an allowed one.
 */
instancesApp.post('/:orgId/instances/:id/size', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const input = await body(c, SizeSchema);
  const sizes = computeSizes(c.env);
  const size = sizes.byId(input.size);
  if (!size) throw new HTTPException(400, { message: 'size_not_allowed' });
  const tier = await tierFor(c.env, orgId);
  if (size.id !== sizes.of(row).id && !tier.sizes.includes(size.id)) throw new HTTPException(400, { message: 'size_not_allowed' });
  const result = await changeSize(c.env, row, size, userId(c));
  return c.json({ ok: true, result, size: sizeView(size) });
});

// ---- outbound network policy (D73) ----

/** A refused policy: 400 with the code, the list (`field`) and the entry, for the console's field error. */
function policyRefusal(c: Context<AppContext>, problem: PolicyProblem): Response {
  return c.json({ error: problem.code, field: problem.field, ...(problem.entry ? { entry: problem.entry } : {}), ...(problem.reason ? { reason: problem.reason } : {}) }, 400);
}

/** Loosening (egress.ts isLoosening) needs a passkey session, as turning remote access on does (D72, D24). */
function requireMfaToLoosen(c: Context<AppContext>, from: EgressPolicy, to: EgressPolicy): void {
  if (isLoosening(from, to, platformEgressHosts(c.env)) && !c.get('session')?.mfa) throw new HTTPException(403, { message: 'mfa_required' });
}

/** The org's policy, the platform's own hosts, and how many instances follow it (the Security page). */
instancesApp.get('/:orgId/egress', session, admin, async (c) => {
  const orgId = c.req.param('orgId');
  const [org, counts] = await Promise.all([readOrgEgress(c.env, orgId), inheritCounts(c.env, orgId)]);
  const { overrides, ...instances } = counts;
  return c.json({ policy: org.policy, version: org.version, platformHosts: platformEgressHosts(c.env), instances, overrides });
});

/**
 * Changes the org's policy. `version`: the one the change was based on (409 egress_changed when it
 * moved). Loosening needs an MFA session. Every instance that follows the org's policy gets it:
 * running ones restart Worca now (`applying`), the others on their next start (`pending`).
 */
instancesApp.put('/:orgId/egress', session, admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const input = await body(c, OrgEgressSchema);
  const norm = normalizePolicy(input.policy, platformEgressHosts(c.env));
  if ('problem' in norm) return policyRefusal(c, norm.problem);
  const current = await readOrgEgress(c.env, orgId);
  if (current.version !== input.version) throw new HTTPException(409, { message: 'egress_changed' });
  requireMfaToLoosen(c, current.policy, norm.policy);
  const out = await changeOrgEgress(c.env, orgId, current, norm.policy, actorId);
  return c.json({ ok: true, ...out, policy: norm.policy });
});

/** The instance's effective policy and where it comes from; everyone who can see the instance. */
instancesApp.get('/:orgId/instances/:id/egress', member, async (c) => {
  const orgId = c.req.param('orgId');
  const [row] = await visibleRows(c.env, orgId, userId(c), c.req.param('id'));
  if (!row) throw new HTTPException(404, { message: 'not_found' });
  const e = await instanceEgress(c.env, row);
  return c.json({
    effective: e.effective,
    inherited: e.inherited,
    override: e.override,
    org: e.org,
    version: row.egress_version ?? 0,
    pending: !!row.egress_pending,
    platformHosts: platformEgressHosts(c.env),
  });
});

/**
 * Sets the instance's override (`policy`) or removes it (`policy: null`: follow the org's policy).
 * `version`: the instance's egress version the change was based on. Loosening the effective policy
 * needs an MFA session (removing an override that was stricter than the org's counts). Results as
 * remote access: 'applying' (Worca restarts), 'saved' (next start), 'stored' (nothing to apply),
 * 'unchanged'. Always 200, for the same reason as remote access.
 */
instancesApp.put('/:orgId/instances/:id/egress', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const input = await body(c, InstanceEgressSchema);
  let next: EgressPolicy | null = null;
  if (input.policy) {
    const norm = normalizePolicy(input.policy, platformEgressHosts(c.env));
    if ('problem' in norm) return policyRefusal(c, norm.problem);
    next = norm.policy;
  }
  if ((row.egress_version ?? 0) !== input.version) throw new HTTPException(409, { message: 'egress_changed' });
  if (row.status === 'deleting') throw new HTTPException(409, { message: 'instance_busy' });
  const cur = await instanceEgress(c.env, row);
  requireMfaToLoosen(c, cur.effective, next ?? cur.org.policy);
  const result = await changeInstanceEgress(c.env, row, cur, next, actorId);
  return c.json({ ok: true, result });
});

// ---- git credentials (D79) ----

/**
 * The instance's git configuration without a single secret. Tenant admins get all of it; members
 * who can see the instance only what concerns them: who pushes go out as, and whether they can
 * sign in with GitHub on the key page (else they paste a token there).
 */
instancesApp.get('/:orgId/instances/:id/git', member, async (c) => {
  const orgId = c.req.param('orgId');
  const uid = userId(c);
  const [row] = await visibleRows(c.env, orgId, uid, c.req.param('id'));
  if (!row) throw new HTTPException(404, { message: 'not_found' });
  const v = gitView(await readGit(c.env, row));
  const signIn = v.github?.kind === 'app' && v.github.signIn;
  if (!(await isOrgAdmin(c.env, orgId, uid))) {
    return c.json({ pushAs: v.pushAs, github: v.github ? { kind: v.github.kind } : null, signIn, configured: !!row.git_settings });
  }
  return c.json({ ...v, signIn, configured: !!row.git_settings, version: row.git_version ?? 0, pending: !!row.git_pending && !!row.git_version });
});

/**
 * Sets the instance's git configuration. The body is the wanted state; a secret left out keeps the
 * stored one, a host set to null removes its credential. `version`: the git version the change was
 * based on (409 git_changed). Adding or replacing a credential or the client secret, or changing the
 * clone allowlist, needs a passkey session. A new GitHub App or token is checked against GitHub
 * first (422 with the reason and field; 502 git_check_failed when GitHub didn't answer). Results as
 * remote access: 'applying' (Worca restarts), 'saved' (next start), 'unchanged'. Always 200.
 */
instancesApp.put('/:orgId/instances/:id/git', admin, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  const { version, ...input } = await body(c, GitSchema);
  if ((row.git_version ?? 0) !== version) throw new HTTPException(409, { message: 'git_changed' });
  if (row.status === 'deleting' || row.status === 'creating') throw new HTTPException(409, { message: 'instance_busy' });
  const cur = await readGit(c.env, row);
  const merged = mergeGitInput(cur, input as GitInput, Date.now());
  if ('problem' in merged) return c.json({ error: merged.problem.code, field: merged.problem.field, ...(merged.problem.entry ? { entry: merged.problem.entry } : {}) }, 400);
  let next = merged.next;
  if (gitNeedsMfa(cur, next) && !c.get('session')?.mfa) throw new HTTPException(403, { message: 'mfa_required' });
  if (githubNeedsCheck(cur, next)) {
    try {
      next = await checkGithub(next);
    } catch (err) {
      if (!(err instanceof GithubCheckError)) throw err;
      return c.json({ error: err.code, field: err.field }, err.code === 'git_check_failed' ? 502 : 422);
    }
    // Sign-in needs the App's client ID, which only GitHub's answer gives.
    if (next.github?.kind === 'app' && next.github.signIn && !next.github.clientId) {
      return c.json({ error: 'git_app_rejected', field: 'github.clientSecret' }, 422);
    }
  }
  const result = await changeInstanceGit(c.env, row, cur, next, actorId);
  return c.json({ ok: true, result, git: gitView(next) });
});

/**
 * D30: typed name here (with an MFA session, D24), then the emailed confirmation runs
 * `instance.delete`. Allowed while stopped (D60). Same answers as DELETE /api/orgs/:orgId.
 */
instancesApp.post('/:orgId/instances/:id/delete', admin, requireMfa, async (c) => {
  const orgId = c.req.param('orgId');
  const actorId = userId(c);
  const row = await loadOwned(c.env, orgId, c.req.param('id'));
  if (row.status === 'deleting') throw new HTTPException(409, { message: 'already_deleting' });
  const name = await decryptDisplayName(c.env, row);
  const input = await body(c, DeleteSchema);
  if ((input.confirmName ?? input.name ?? '').trim() !== name) throw new HTTPException(422, { message: 'confirm_name_mismatch' });
  const started = await deps().startConfirmation(c.env, {
    userId: actorId,
    orgId,
    action: CONFIRM_DELETE,
    target: row.id,
    payload: {},
    summary: `Delete the instance ${name} (${hostFor(c.env, row.slug)}) and all its data`,
  });
  return confirmationSent(c, started);
});

export const CONFIRM_DELETE = 'instance.delete';

/** Runs on the confirming POST of the emailed link (D30). Re-checks that the user is still an admin. */
export const confirmDeleteHandler: ConfirmHandler = async (env, _ctx, { userId: uid, orgId, target }) => {
  const row = await env.DB.prepare(`SELECT org_id FROM instances WHERE id = ?`).bind(target).first<{ org_id: string }>();
  if (!row || (orgId && row.org_id !== orgId)) throw new HTTPException(404, { message: 'not_found' });
  if (!(await isOrgAdmin(env, row.org_id, uid))) throw new HTTPException(403, { message: 'forbidden' });
  await deleteInstanceNow(env, target, { actorId: uid, actorScope: 'tenant' });
};

deps().registerConfirmAction(CONFIRM_DELETE, confirmDeleteHandler, { label: 'Delete an instance' });

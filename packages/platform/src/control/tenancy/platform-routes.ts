// Platform console API, mounted at /api/platform (D13–D16, D25, D33, D47). Platform staff see
// ids, statuses, counts and versions, plus org and instance names and tenant admins' addresses
// (product decision 2026-10-06: D15 protects instance contents, not names). Never tenant content.
// Reading names is not audited.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { gate } from '../gate-client';
import { auditOrg, auditPlatform, parseAuditQuery, readPlatformAudit, type PlatformActorRole } from './audit';
import { deps } from './deps';
import { purgeUser } from './lifecycle';
import { can, getPlatformRoles, PLATFORM_ROLES, requireCap, strongestRole } from './roles';
import { actor, fail, field, notifyUsers, orgOwner, parseBody as parseJson, tryDecrypt, userProfile } from './util';
import { compareVersions, imageSources, isRc, isVersion, isWithdrawn, latestWorcaVersion, rcRunsHosted, releaseCandidates, runsHosted } from '../instances/images';
import { STALE_AFTER_MS } from '../instances/crons';
import { checkImage } from '../instances/registry';
import { enrollRelease, MAX_SOAK_HOURS, releaseSettings, restoreRelease, setReleaseSettings, withdrawRelease } from '../instances/releases';
import { hostFor, instanceUrl } from '../instances/api';
import { supportApp } from './support-routes';
import { featureOn } from '../features';
import { accessRequestsApp } from './access-requests-routes';
import { codeNoteField, createRegistrationCode } from './registration-codes';
import { computeView } from '../instances/compute-facts';
import { providerStatusFor } from '../instances/provider-status';
import { latestOps } from '../instances/progress';
import { platformOpView } from '../instances/platform-ops-routes';
import { instanceEgress, readOrgEgress } from '../instances/egress-api';
import { computeSizes, sizeView, type SizeTable } from '../instances/sizes';
import { computeInfo, DEPLOYMENT_SETTINGS_KEY, savedDeploymentSettings } from '../providers';
import { effectiveSettings, secretsSet, SettingsError, storeValues, validateSettings } from '../providers/settings';


/** Which compute provider the consoles talk about (its name and how to call it). */
function computeProviderView(env: Env) {
  const info = computeInfo(env);
  return { name: env.COMPUTE_PROVIDER, displayName: info.displayName, egressEnforcement: info.egressEnforcement };
}

/** D78: the provider's capacity in use for `instances` instance rows; null when it has no limit. */
function capacityView(env: Env, instances: number) {
  const cap = computeInfo(env).capacity;
  if (!cap) return null;
  const used = instances * cap.perInstance;
  return { unit: cap.unit, used, limit: cap.limit, services: used, cap: cap.limit };
}

export const platformApp = new Hono<AppContext>();

// P8: /users (exact-email lookup, sign-out, disable, enable, reset-signin) and /support-requests.
platformApp.route('/', supportApp);
// /access-requests: the website's access requests (superadmin, D69).
platformApp.route('/', accessRequestsApp);

async function staff(c: Context<AppContext>): Promise<{ id: string; role: PlatformActorRole }> {
  const { user } = actor(c);
  return { id: user.id, role: strongestRole(await getPlatformRoles(c.env, user.id)) ?? 'user' };
}

const paging = (c: Context<AppContext>) => ({
  limit: Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500),
  offset: Math.max(Number(c.req.query('offset')) || 0, 0),
});

// ---- orgs and instances (status and names) ----------------------------------------------------

/** organization.name, decrypted with the org key; null when the key is destroyed. */
const decryptOrgName = (env: Env, orgId: string, value: unknown) => tryDecrypt(env, field('organization', 'name', orgId, orgOwner(orgId)), value);
/** instances.display_name, decrypted with the org key; null when the key is destroyed. */
const decryptInstanceName = (env: Env, id: string, orgId: string, value: unknown) =>
  tryDecrypt(env, field('instances', 'display_name', id, orgOwner(orgId)), value);

platformApp.get('/orgs', requireCap('platform.view'), async (c) => {
  const { limit, offset } = paging(c);
  const rows = await c.env.DB.prepare(
    `SELECT s.org_id AS id, o.name AS encName, s.tier, s.status, s.created_at AS createdAt,
            (SELECT COUNT(*) FROM member m WHERE m.organizationId = s.org_id) AS members,
            (SELECT COUNT(*) FROM instances i WHERE i.org_id = s.org_id) AS instances
     FROM org_settings s LEFT JOIN organization o ON o.id = s.org_id
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<{ id: string; encName: string | null } & Record<string, unknown>>();
  const orgs = [];
  const tiers = featureOn(c.env, 'tiers'); // 2.4: without tiers an org has no tier to show
  for (const { encName, ...r } of rows.results) orgs.push({ ...r, ...(tiers ? {} : { tier: null }), name: await decryptOrgName(c.env, r.id, encName) });
  return c.json({ orgs });
});

/** P5: one org with its tenant admins' addresses and its instances' status. */
platformApp.get('/orgs/:orgId', requireCap('platform.view'), async (c) => {
  const orgId = c.req.param('orgId');
  const org = await c.env.DB.prepare(
    `SELECT s.org_id AS id, o.name AS encName, s.tier, s.status, s.created_at AS createdAt, s.rc_access AS rcAccess,
            (SELECT COUNT(*) FROM member m WHERE m.organizationId = s.org_id) AS members,
            t.name AS tierName, t.instances_per_org AS instanceLimit, t.members AS memberLimit, t.sizes AS tierSizes
     FROM org_settings s LEFT JOIN organization o ON o.id = s.org_id LEFT JOIN tiers t ON t.id = s.tier WHERE s.org_id = ?`,
  )
    .bind(orgId)
    .first<{
      id: string; encName: string | null; tier: string; status: string; createdAt: number; rcAccess: number; members: number;
      tierName: string | null; instanceLimit: number | null; memberLimit: number | null; tierSizes: string | null;
    }>();
  if (!org) fail(404, 'not_found');
  const { encName, tierSizes, rcAccess, ...rest } = org;
  if (!featureOn(c.env, 'tiers')) Object.assign(rest, { tier: null, tierName: null, instanceLimit: null, memberLimit: null }); // 2.4
  // Tenant admins, longest-standing first: the first is the org's founder unless they left.
  const adminRows = await c.env.DB.prepare(
    "SELECT userId, createdAt FROM member WHERE organizationId = ? AND role = 'tenant_admin' ORDER BY createdAt, id",
  )
    .bind(orgId)
    .all<{ userId: string; createdAt: unknown }>();
  const admins = [];
  for (const a of adminRows.results) {
    const p = await userProfile(c.env, a.userId);
    admins.push({ userId: a.userId, email: p?.email ?? null, since: a.createdAt });
  }
  const instRows = await c.env.DB.prepare(
    `SELECT id, display_name AS encName, status, worca_version AS version, available_version AS availableVersion, health,
            last_heartbeat_at AS lastHeartbeatAt, stopped_reason IS NOT NULL AS stoppedForAbuse, created_at AS createdAt,
            compute_size AS size, ${aboveTier(c.env)}
     FROM instances WHERE org_id = ? ORDER BY created_at`,
  )
    .bind(orgId)
    .all<{ id: string; encName: string } & Record<string, unknown>>();
  const instances = [];
  for (const { encName: n, ...r } of instRows.results) instances.push({ ...r, name: await decryptInstanceName(c.env, r.id, orgId, n) });
  // D73, read-only here: the org's outbound network policy (null when it can't be read).
  const egress = await readOrgEgress(c.env, orgId).then((e) => e.policy).catch(() => null);
  return c.json({
    ...rest,
    tierSizes: tierSizes === null || !featureOn(c.env, 'tiers') ? [] : computeSizes(c.env).parseTier(tierSizes),
    // D80: its tenant admins may pin instances to release candidates.
    releaseCandidates: !!rcAccess,
    name: await decryptOrgName(c.env, orgId, encName),
    firstAdmin: admins[0] ?? null,
    admins,
    instances,
    egress,
  });
});

/**
 * D78: 1 when the instance runs on a compute size its org's tier no longer allows (the org moved to
 * a lower tier); it keeps that size until a tenant admin moves it. For queries `FROM instances`.
 */
const ABOVE_TIER_SQL = `NOT EXISTS (SELECT 1 FROM org_settings s JOIN tiers t ON t.id = s.tier, json_each(t.sizes) j
                     WHERE s.org_id = instances.org_id AND j.value = instances.compute_size) AS aboveTier`;
/** Without tiers (2.4) every size is allowed, so no instance is above its tier. */
const aboveTier = (env: Env) => (featureOn(env, 'tiers') ? ABOVE_TIER_SQL : '0 AS aboveTier');

const instanceStatusColumns = (env: Env) =>
  `id, org_id AS orgId, display_name AS encName, status, worca_version AS version, available_version AS availableVersion, health, last_heartbeat_at AS lastHeartbeatAt, stopped_reason IS NOT NULL AS stoppedForAbuse, created_at AS createdAt, compute_size AS size, ${aboveTier(env)}`;

type InstanceStatusRow = { id: string; orgId: string; encName: string } & Record<string, unknown>;

/** Replaces the encrypted display name with its plaintext as `name`. */
async function withName(env: Env, { encName, ...r }: InstanceStatusRow) {
  return { ...r, name: await decryptInstanceName(env, r.id, r.orgId, encName) };
}

/** Provider refs without anything secret: only the ids the console links to are copied. */
function safeComputeRef(raw: string | null): unknown {
  const ref = parseJsonObject(raw);
  if (!ref) return null;
  const services: Record<string, { serviceId: unknown; deploymentId: unknown }> = {};
  const src = ref.services && typeof ref.services === 'object' ? (ref.services as Record<string, Record<string, unknown>>) : {};
  for (const [name, s] of Object.entries(src)) {
    if (s && typeof s === 'object') services[name] = { serviceId: s.serviceId ?? null, deploymentId: s.deploymentId ?? null };
  }
  return { projectId: ref.projectId ?? null, environmentId: ref.environmentId ?? null, services };
}

function safeEdgeRef(raw: string | null): unknown {
  const ref = parseJsonObject(raw);
  if (!ref) return null;
  return { tunnelId: ref.tunnelId ?? null, dnsRecordIds: Array.isArray(ref.dnsRecordIds) ? ref.dnsRecordIds.filter((x) => typeof x === 'string') : [] };
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Latest pipeline counts from the heartbeats table (instances module); absent until it exists. */
async function latestPipelines(env: Env, instanceId: string): Promise<unknown> {
  try {
    const row = await env.DB.prepare('SELECT * FROM heartbeats WHERE instance_id = ? ORDER BY received_at DESC LIMIT 1').bind(instanceId).first<Record<string, unknown>>();
    if (!row) return null;
    const raw = row.pipelines ?? row.pipeline_counts ?? null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

platformApp.get('/instances', requireCap('platform.view'), async (c) => {
  const { limit, offset } = paging(c);
  const orgId = c.req.query('orgId');
  const stmt = orgId
    ? c.env.DB.prepare(`SELECT ${instanceStatusColumns(c.env)} FROM instances WHERE org_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(orgId, limit, offset)
    : c.env.DB.prepare(`SELECT ${instanceStatusColumns(c.env)} FROM instances ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(limit, offset);
  const rows = await stmt.all<InstanceStatusRow>();
  const instances = [];
  for (const r of rows.results) instances.push({ ...(await withName(c.env, r)), pipelines: await latestPipelines(c.env, r.id) });
  return c.json({ instances });
});

/** P6: status plus size, compute facts, provider ids (never secrets) and the org's name. */
platformApp.get('/instances/:id', requireCap('platform.view'), async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT ${instanceStatusColumns(c.env)}, compute_ref AS computeRef, edge_ref AS edgeRef, cpu, memory_mb AS memoryMb, volume_gb AS volumeGb,
            stopped_reason AS stoppedReason, health_since AS healthSince, slug, key_slug AS keySlug,
            compute_facts, compute_facts_at, CASE WHEN auto_update <> 'micro' THEN 'off' WHEN auto_update_minor = 1 THEN 'minor' ELSE 'micro' END AS autoUpdate, auto_update_failed_version AS autoUpdateFailedVersion,
            terminal_remote, actions_remote, remote_pending, egress_mode, egress_hosts, egress_pending,
            secrets_rotated_at AS secretsRotatedAt, pending_op AS pendingOp, size_pending AS sizePending
     FROM instances WHERE id = ?`,
  )
    .bind(id)
    .first<
      InstanceStatusRow & {
        computeRef: string | null; edgeRef: string | null; slug: string; keySlug: string; compute_facts: string | null; compute_facts_at: number | null;
        autoUpdate: string; autoUpdateFailedVersion: string | null; terminal_remote: number; actions_remote: number; remote_pending: number;
        egress_mode: 'open' | 'block' | 'allow' | null; egress_hosts: string | null; egress_pending: number;
        secretsRotatedAt: number | null; pendingOp: string | null; sizePending: number;
      }
    >();
  if (!row) fail(404, 'not_found');
  let gateState: unknown = null;
  try {
    gateState = await gate(c.env).getState(id);
  } catch {
    gateState = null;
  }
  const org = await c.env.DB.prepare('SELECT name FROM organization WHERE id = ?').bind(row.orgId).first<{ name: string }>();
  const { computeRef, edgeRef, slug, keySlug, compute_facts, compute_facts_at, terminal_remote, actions_remote, remote_pending, egress_mode, egress_hosts, egress_pending, sizePending, ...status } = row;
  // D73, read-only here: the effective outbound network policy, and whether it is the org's.
  let egress: { effective: unknown; inherited: boolean; pending: boolean } | null = null;
  try {
    const e = await instanceEgress(c.env, { id, org_id: row.orgId, egress_mode, egress_hosts });
    egress = { effective: e.effective, inherited: e.inherited, pending: !!egress_pending };
  } catch (err) {
    console.error(JSON.stringify({ at: 'platform.instance.egress', id, message: (err as Error).message }));
  }
  const op = (await latestOps(c.env, [id])).get(id);
  return c.json({
    ...(await withName(c.env, status)),
    orgName: org ? await decryptOrgName(c.env, row.orgId, org.name) : null,
    // The addresses, not access: the gate still refuses every platform role (D15).
    url: instanceUrl(c.env, hostFor(c.env, slug)),
    keyUrl: instanceUrl(c.env, hostFor(c.env, keySlug)),
    // What the compute provider last reported (region, per-service ceilings, volumes); cpu/memoryMb
    // are the compute size's worca ceiling (D78), volumeGb the tier's. Null until first checked.
    compute: computeView(computeInfo(c.env), { compute_facts, compute_facts_at }),
    computeProvider: computeProviderView(c.env),
    // D72, read-only here: only the org's tenant admins change it.
    remoteAccess: { terminal: !!terminal_remote, actions: !!actions_remote, pending: !!remote_pending },
    // D78, read-only here: tenant admins pick the size.
    computeSize: { ...sizeView(computeSizes(c.env).of({ compute_size: status.size as string })), pending: !!sizePending },
    egress,
    computeRef: safeComputeRef(computeRef),
    edgeRef: safeEdgeRef(edgeRef),
    pipelines: await latestPipelines(c.env, id),
    gate: gateState,
    providers: await providerStatusFor(c.env, id).catch(() => null), // staff only: may name provider ids
    op: op ? platformOpView(op, Date.now()) : null, // the latest operation, with step and last error
  });
});

// ---- overview stats (P1, P3) and key counts (P12) ---------------------------------------------

export const STUCK_CREATING_MS = 10 * 60_000;
const WEEK_MS = 7 * 86_400_000;

platformApp.get('/stats', requireCap('platform.view'), async (c) => {
  const now = Date.now();
  const db = c.env.DB;
  const [orgs, users, byStatus, health, waitlist, codes, versions, accessRequests, allInstances] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?), 0) AS createdLast7Days FROM org_settings').bind(now - WEEK_MS),
    db.prepare("SELECT COALESCE(status, 'active') AS status, COUNT(*) AS n FROM user GROUP BY 1"),
    db.prepare('SELECT status, COUNT(*) AS n FROM instances GROUP BY status'),
    // Silent uses the threshold markStale (instances/crons.ts) marks degraded at.
    db.prepare(
      `SELECT COALESCE(SUM(status = 'running' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)), 0) AS silent,
              COALESCE(SUM(status = 'running' AND health = 'degraded'), 0) AS degraded,
              COALESCE(SUM(status = 'creating' AND created_at < ?), 0) AS stuck
       FROM instances`,
    ).bind(now - STALE_AFTER_MS, now - STUCK_CREATING_MS),
    db.prepare("SELECT COUNT(*) AS n FROM user WHERE status = 'pending'"),
    db.prepare('SELECT COUNT(*) AS n FROM registration_codes WHERE uses_left > 0 AND (expires_at IS NULL OR expires_at > ?)').bind(now),
    db.prepare('SELECT worca_version AS version, COUNT(*) AS n FROM instances WHERE worca_version IS NOT NULL GROUP BY worca_version'),
    db.prepare("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'"),
    db.prepare('SELECT COUNT(*) AS n FROM instances'),
  ]);
  const counts = (rows: Record<string, unknown>[] | undefined, key: string) =>
    Object.fromEntries((rows ?? []).map((r) => [String(r[key]), Number(r.n)]));
  const userCounts = counts(users?.results, 'status');
  const o = orgs?.results[0] ?? {};
  const h = health?.results[0] ?? {};
  return c.json({
    orgs: { total: Number(o.total ?? 0), createdLast7Days: Number(o.createdLast7Days ?? 0) },
    users: { total: Object.values(userCounts).reduce((a, b) => a + b, 0), active: userCounts.active ?? 0, pending: userCounts.pending ?? 0, disabled: userCounts.disabled ?? 0 },
    instances: {
      byStatus: counts(byStatus?.results, 'status'),
      silent: Number(h.silent ?? 0),
      degraded: Number(h.degraded ?? 0),
      stuckCreating: Number(h.stuck ?? 0),
      byVersion: counts(versions?.results, 'version'),
    },
    waitlist: Number(waitlist?.results[0]?.n ?? 0),
    openRegistrationCodes: Number(codes?.results[0]?.n ?? 0),
    accessRequestsPending: Number(accessRequests?.results[0]?.n ?? 0),
    thresholds: { silentAfterMs: STALE_AFTER_MS, stuckCreatingAfterMs: STUCK_CREATING_MS },
    // D78: the compute provider's capacity in use (every instance row holds its share, deleting ones
    // too) of the account's limit; null when the provider has none. `services`/`cap` are the older names.
    capacity: capacityView(c.env, Number(allInstances?.results[0]?.n ?? 0)),
    computeProvider: computeProviderView(c.env),
  });
});

/**
 * P12: live data keys by owner type, data-key version and the master key that wrapped them
 * (data_keys.master_id, a fingerprint; null on rows wrapped before migration 0011), the master
 * rotation status from keys.ts, and destroyed (crypto-erased) keys counted apart. Master key
 * fingerprints (the `master` block and each group's masterId) only for 'keys.master'; other
 * staff get the counts by owner type and version.
 */
platformApp.get('/keys', requireCap('platform.view'), async (c) => {
  const seesMaster = can(await getPlatformRoles(c.env, actor(c).user.id), 'keys.master');
  const rows = await c.env.DB.prepare(
    `SELECT owner_type AS ownerType, version, master_id AS masterId, wrapped IS NULL AS destroyed,
            COUNT(*) AS n, MAX(created_at) AS lastCreatedAt
     FROM data_keys WHERE NOT (owner_type = 'user' AND substr(owner_id, 1, 3) IN ('ar_', 'nl_'))
     GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3`,
  ).all<{ ownerType: 'org' | 'user'; version: number; masterId: string | null; destroyed: number; n: number; lastCreatedAt: number }>();
  // Keys of access requests (`ar_`, D69) and newsletter subscribers (`nl_`, D70) are user-type
  // keys of people without an account: counted apart, so `user` means accounts. They are deleted
  // with their row, never left destroyed.
  const form = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(substr(owner_id, 1, 3) = 'ar_'), 0) AS accessRequests, COALESCE(SUM(substr(owner_id, 1, 3) = 'nl_'), 0) AS newsletter
     FROM data_keys WHERE owner_type = 'user' AND wrapped IS NOT NULL`,
  ).first<{ accessRequests: number; newsletter: number }>();
  const formKeys = { accessRequests: Number(form?.accessRequests ?? 0), newsletter: Number(form?.newsletter ?? 0) };
  type Group = { version: number; masterId?: string | null; count: number };
  const wrapped: Record<'org' | 'user', Group[]> = { org: [], user: [] };
  const destroyed = { org: 0, user: 0 };
  let lastOrgKeyRotationAt: number | null = null;
  for (const r of rows.results) {
    if (r.destroyed) {
      destroyed[r.ownerType] += r.n;
      continue;
    }
    const groups = wrapped[r.ownerType];
    if (seesMaster) groups.push({ version: r.version, masterId: r.masterId, count: r.n });
    else {
      const same = groups.find((g) => g.version === r.version);
      if (same) same.count += r.n;
      else groups.push({ version: r.version, count: r.n });
    }
    if (r.ownerType === 'org' && r.version > 1) lastOrgKeyRotationAt = Math.max(lastOrgKeyRotationAt ?? 0, r.lastCreatedAt);
  }
  if (!seesMaster) return c.json({ wrapped, destroyed, formKeys, lastOrgKeyRotationAt });
  let master: unknown = null;
  try {
    const { masterKeyStatus } = await import('../keys');
    master = await masterKeyStatus(c.env);
  } catch (err) {
    console.error(JSON.stringify({ at: 'platform.keys', message: (err as Error).message }));
  }
  return c.json({ wrapped, destroyed, formKeys, master, lastOrgKeyRotationAt });
});

// ---- abuse: stop and lift (D16, D47) ----------------------------------------------------------

async function instanceOrg(env: Env, id: string): Promise<string> {
  const row = await env.DB.prepare('SELECT org_id FROM instances WHERE id = ?').bind(id).first<{ org_id: string }>();
  if (!row) fail(404, 'not_found');
  return row.org_id;
}

/** instances/api.ts audits (platform and org logs) and notifies the tenant admins (D16). */
platformApp.post('/instances/:id/stop', requireCap('instances.stop'), async (c) => {
  const id = c.req.param('id');
  const me = await staff(c);
  const { reason } = await parseJson(c, z.object({ reason: z.string().trim().min(1).max(1000) }));
  await instanceOrg(c.env, id);
  await deps().instances.stopForAbuse(c.env, id, { actorId: me.id, reason, actorRole: me.role });
  return c.json({ ok: true });
});

platformApp.post('/instances/:id/lift', requireCap('instances.stop'), async (c) => {
  const id = c.req.param('id');
  const me = await staff(c);
  await instanceOrg(c.env, id);
  await deps().instances.liftStop(c.env, id, { actorId: me.id, actorRole: me.role });
  return c.json({ ok: true });
});

// ---- tiers ------------------------------------------------------------------------------------

type TierDbRow = {
  id: string; name: string; instances_per_org: number; vcpu: number; memory_mb: number; volume_gb: number; members: number;
  sizes: string | null; default_size: string | null; orgs: number;
};

/**
 * Every tier with what an org on it gets (D33, D78), how many orgs are on it, the compute sizes
 * there are, and the tier new orgs start on. The raw columns stay for older consoles.
 */
platformApp.get('/tiers', requireCap('platform.view'), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM org_settings s WHERE s.tier = t.id) AS orgs FROM tiers t ORDER BY t.instances_per_org, t.id`,
  ).all<TierDbRow>();
  const dflt = await c.env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'default_tier'").first<{ value: string }>();
  const table = computeSizes(c.env);
  const tiers = results.map((t) => {
    const sizes = table.parseTier(t.sizes);
    return { ...t, sizes, default_size: t.default_size && sizes.includes(t.default_size) ? t.default_size : sizes[0] };
  });
  return c.json({ tiers, computeSizes: table.all.map(sizeView), defaultTier: dflt?.value ?? 'free', computeProvider: computeProviderView(c.env) });
});

/** The tier fields, with the sizes the compute provider offers. */
function tierFieldsSchema(sizes: SizeTable) {
  const sizeId = z.enum(sizes.all.map((s) => s.id) as [string, ...string[]]);
  return z
    .object({
      name: z.string().trim().min(1).max(60),
      instancesPerOrg: z.number().int().min(1).max(100),
      members: z.number().int().min(1).max(1000),
      volumeGb: z.number().int().min(1).max(1000),
      sizes: z.array(sizeId).min(1).max(sizes.all.length),
      defaultSize: sizeId,
    })
    .strict()
    .refine((t) => t.sizes.includes(t.defaultSize), { message: 'default_size_not_in_sizes', path: ['defaultSize'] });
}
type TierFields = z.infer<ReturnType<typeof tierFieldsSchema>>;
const TierIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);

/** The tier columns from the fields; vcpu and memory_mb are the default size's (older readers). */
function tierColumns(table: SizeTable, t: TierFields) {
  const sizes = table.parseTier(t.sizes); // known ids, the provider's order, no duplicates
  const d = table.byId(t.defaultSize)!;
  return [t.name, t.instancesPerOrg, d.vcpu, d.memoryMb, t.volumeGb, t.members, JSON.stringify(sizes), d.id] as const;
}

// Size lists in platform audit details are joined with '.' (details hold ids only, D15: no commas).

// ---- compute provider settings (docs/providers.md "Settings") ---------------------------------------

/**
 * The deployment's provider settings: the fields the configured compute provider declares, what a
 * superadmin saved, what the provider gets (defaults filled in), and whether each named secret is
 * set on the Worker. Never a secret's value.
 */
platformApp.get('/provider-settings', requireCap('platform.view'), async (c) => {
  const info = computeInfo(c.env);
  const fields = info.settings?.deployment ?? [];
  const saved = await savedDeploymentSettings(c.env);
  const values = effectiveSettings(fields, saved);
  return c.json({ provider: computeProviderView(c.env), fields, saved: saved ?? {}, values, secretsSet: secretsSet(fields, values, c.env) });
});

/** Saves them, validated against the provider's declaration; operations started from now on use them. */
platformApp.put('/provider-settings', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const fields = computeInfo(c.env).settings?.deployment ?? [];
  const input = (await c.req.json().catch(() => null)) as { values?: unknown } | null;
  let values;
  try {
    values = validateSettings(fields, input?.values);
  } catch (err) {
    if (err instanceof SettingsError) return c.json({ error: 'invalid_provider_settings', problems: err.problems }, 400);
    throw err;
  }
  await c.env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(DEPLOYMENT_SETTINGS_KEY, storeValues(c.env.COMPUTE_PROVIDER, values), Date.now())
    .run();
  // Keys only: a value may be an account id (secret fields hold names, never values, but still).
  await auditPlatform(c.env, {
    actorId: me.id, actorRole: me.role, action: 'platform.provider_settings_set', targetType: 'system', targetId: null,
    details: { provider: c.env.COMPUTE_PROVIDER, keys: Object.keys(values).sort().join('.') },
  });
  const effective = effectiveSettings(fields, values);
  return c.json({ ok: true, values: effective, secretsSet: secretsSet(fields, effective, c.env) });
});

/** D78: a new tier. The id is permanent (orgs and registration codes refer to it). */
platformApp.post('/tiers', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const table = computeSizes(c.env);
  const body = await parseJson(c, tierFieldsSchema(table).and(z.object({ id: TierIdSchema })));
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO tiers (name, instances_per_org, vcpu, memory_mb, volume_gb, members, sizes, default_size, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(...tierColumns(table, body), body.id)
    .run();
  if (!res.meta.changes) fail(409, 'tier_exists');
  await auditPlatform(c.env, {
    actorId: me.id, actorRole: me.role, action: 'platform.tier_created', targetType: 'tier', targetId: body.id,
    details: { instancesPerOrg: body.instancesPerOrg, members: body.members, sizes: body.sizes.join('.'), defaultSize: body.defaultSize },
  });
  return c.json({ ok: true, id: body.id }, 201);
});

/**
 * D78: changes a tier. Its orgs get the new limits at once; nothing running is changed: an org over
 * the new instance limit keeps its instances (no new ones), an instance on a size no longer allowed
 * keeps it until moved.
 */
platformApp.put('/tiers/:id', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const id = c.req.param('id');
  const table = computeSizes(c.env);
  const body = await parseJson(c, tierFieldsSchema(table));
  const before = await c.env.DB.prepare('SELECT instances_per_org, members, sizes, default_size FROM tiers WHERE id = ?')
    .bind(id)
    .first<{ instances_per_org: number; members: number; sizes: string | null; default_size: string | null }>();
  if (!before) fail(404, 'not_found');
  await c.env.DB.prepare(
    `UPDATE tiers SET name = ?, instances_per_org = ?, vcpu = ?, memory_mb = ?, volume_gb = ?, members = ?, sizes = ?, default_size = ? WHERE id = ?`,
  )
    .bind(...tierColumns(table, body), id)
    .run();
  await auditPlatform(c.env, {
    actorId: me.id, actorRole: me.role, action: 'platform.tier_updated', targetType: 'tier', targetId: id,
    details: {
      fromInstancesPerOrg: before.instances_per_org, toInstancesPerOrg: body.instancesPerOrg,
      fromMembers: before.members, toMembers: body.members,
      fromSizes: table.parseTier(before.sizes).join('.'), toSizes: body.sizes.join('.'),
      fromDefaultSize: before.default_size, toDefaultSize: body.defaultSize,
    },
  });
  return c.json({ ok: true });
});

/** D78: removes a tier nothing refers to: no org on it, not the default for new orgs, no open registration code. */
platformApp.delete('/tiers/:id', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const id = c.req.param('id');
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `DELETE FROM tiers WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM org_settings WHERE tier = ?)
       AND COALESCE((SELECT value FROM platform_settings WHERE key = 'default_tier'), 'free') <> ?
       AND NOT EXISTS (SELECT 1 FROM registration_codes WHERE tier = ? AND uses_left > 0 AND (expires_at IS NULL OR expires_at > ?))`,
  )
    .bind(id, id, id, id, now)
    .run();
  if (!res.meta.changes) {
    if (!(await c.env.DB.prepare('SELECT 1 FROM tiers WHERE id = ?').bind(id).first())) fail(404, 'not_found');
    fail(409, 'tier_in_use');
  }
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.tier_deleted', targetType: 'tier', targetId: id });
  return c.json({ ok: true });
});

platformApp.put('/orgs/:orgId/tier', requireCap('tenants.manage'), async (c) => {
  const orgId = c.req.param('orgId');
  const me = await staff(c);
  const { tier } = await parseJson(c, z.object({ tier: z.string().min(1).max(40) }));
  if (!(await c.env.DB.prepare('SELECT 1 FROM tiers WHERE id = ?').bind(tier).first())) fail(400, 'unknown_tier');
  const current = await c.env.DB.prepare('SELECT tier FROM org_settings WHERE org_id = ?').bind(orgId).first<{ tier: string }>();
  if (!current) fail(404, 'not_found');
  await c.env.DB.prepare('UPDATE org_settings SET tier = ? WHERE org_id = ?').bind(tier, orgId).run();
  const details = { from: current.tier, to: tier };
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'org.tier_changed', targetType: 'org', targetId: orgId, details });
  await auditOrg(c.env, orgId, { actorId: me.id, actorScope: 'platform', action: 'org.tier_changed', targetType: 'org', targetId: orgId, details });
  return c.json({ ok: true });
});

/**
 * D80: release candidates on or off for an org. On, its tenant admins see the candidates of
 * releases not out yet in the version picker and pin instances to one by hand. Off, nothing moves:
 * instances on a candidate keep it until an admin picks a release.
 */
platformApp.put('/orgs/:orgId/release-candidates', requireCap('tenants.manage'), async (c) => {
  const orgId = c.req.param('orgId');
  const me = await staff(c);
  const { enabled } = await parseJson(c, z.object({ enabled: z.boolean() }).strict());
  const current = await c.env.DB.prepare('SELECT rc_access FROM org_settings WHERE org_id = ?').bind(orgId).first<{ rc_access: number }>();
  if (!current) fail(404, 'not_found');
  if (!!current.rc_access === enabled) return c.json({ ok: true, enabled, changed: false });
  await c.env.DB.prepare('UPDATE org_settings SET rc_access = ? WHERE org_id = ?').bind(enabled ? 1 : 0, orgId).run();
  const details = { enabled };
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'org.release_candidates_set', targetType: 'org', targetId: orgId, details });
  await auditOrg(c.env, orgId, { actorId: me.id, actorScope: 'platform', action: 'org.release_candidates_set', targetType: 'org', targetId: orgId, details });
  return c.json({ ok: true, enabled, changed: true });
});

// ---- platform roles (superadmin) --------------------------------------------------------------

platformApp.get('/roles', requireCap('roles.manage'), async (c) => {
  const rows = await c.env.DB.prepare('SELECT user_id AS userId, role, granted_by AS grantedBy, granted_at AS grantedAt FROM platform_roles ORDER BY granted_at').all<{ userId: string }>();
  // P11: staff names and addresses, decrypted with each user's key (one lookup per person).
  const profiles = new Map<string, Awaited<ReturnType<typeof userProfile>>>();
  for (const r of rows.results) if (!profiles.has(r.userId)) profiles.set(r.userId, await userProfile(c.env, r.userId));
  return c.json({
    bindings: rows.results.map((r) => ({ ...r, name: profiles.get(r.userId)?.name ?? null, email: profiles.get(r.userId)?.email ?? null })),
  });
});

const roleBody = z.object({ userId: z.string().min(1).optional(), email: z.email().optional(), role: z.enum(PLATFORM_ROLES) }).refine((b) => b.userId || b.email);

async function resolveUserId(env: Env, body: { userId?: string; email?: string }): Promise<string> {
  if (body.userId) {
    if (!(await env.DB.prepare('SELECT 1 FROM user WHERE id = ?').bind(body.userId).first())) fail(404, 'user_not_found');
    return body.userId;
  }
  // Exact email only, through the blind index (security.md "Looking things up by email").
  const idx = await deps().keyRing(env).emailIndex(body.email as string);
  const row = await env.DB.prepare('SELECT id FROM user WHERE emailIndex = ?').bind(idx).first<{ id: string }>();
  if (!row) fail(404, 'user_not_found');
  return row.id;
}

platformApp.post('/roles', requireCap('roles.manage'), async (c) => {
  const me = await staff(c);
  const body = await parseJson(c, roleBody);
  const userId = await resolveUserId(c.env, body);
  if (userId === me.id) fail(403, 'cannot_change_own_roles');
  await c.env.DB.prepare('INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)').bind(userId, body.role, me.id, Date.now()).run();
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.role_granted', targetType: 'user', targetId: userId, details: { role: body.role } });
  return c.json({ ok: true, userId }, 201);
});

platformApp.delete('/roles/:userId/:role', requireCap('roles.manage'), async (c) => {
  const me = await staff(c);
  const userId = c.req.param('userId');
  const role = c.req.param('role');
  if (userId === me.id) fail(403, 'cannot_change_own_roles');
  // Last-superadmin guard, as one conditional statement (D14, identity-and-access.md).
  const res = await c.env.DB.prepare(
    `DELETE FROM platform_roles WHERE user_id = ? AND role = ?
       AND (role != 'superadmin' OR (SELECT COUNT(*) FROM platform_roles WHERE role = 'superadmin') > 1)`,
  )
    .bind(userId, role)
    .run();
  if (!res.meta.changes) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM platform_roles WHERE user_id = ? AND role = ?').bind(userId, role).first();
    fail(exists ? 409 : 404, exists ? 'last_superadmin' : 'not_found');
  }
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.role_revoked', targetType: 'user', targetId: userId, details: { role } });
  return c.json({ ok: true });
});

// ---- registration (D25) -----------------------------------------------------------------------

const MODES = ['invite_code', 'waitlist', 'open'] as const;

platformApp.get('/registration', requireCap('platform.view'), async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM platform_settings WHERE key = 'registration_mode'").first<{ value: string }>();
  return c.json({ mode: row?.value ?? 'invite_code' });
});

/** The mode is a system setting: superadmin only. */
platformApp.put('/registration', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const { mode } = await parseJson(c, z.object({ mode: z.enum(MODES) }));
  await c.env.DB.prepare(
    "INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(mode, Date.now())
    .run();
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.registration_mode_set', targetType: 'setting', targetId: 'registration_mode', details: { mode } });
  return c.json({ ok: true });
});

platformApp.get('/worca-version', requireCap('platform.view'), async (c) => c.json({ version: await latestWorcaVersion(c.env) }));

/**
 * Publishes a worca release by hand (D26 step 1): it becomes the latest version, even when older,
 * and every other instance gets it as `available_version`. Nobody is upgraded; tenant admins start
 * upgrades. Stable npm releases are enrolled without this (D77, instances/releases.ts); it stays
 * for the cases automatic enrollment skips or holds. 422 when the image tag isn't on GHCR or
 * reports another version (an upgrade to it could never finish), 409 for a withdrawn release
 * (restore it instead), 502 when GHCR can't be asked.
 */
platformApp.put('/worca-version', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const { version } = await parseJson(c, z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }));
  if (!runsHosted(version)) fail(422, 'version_unsupported');
  if (await isWithdrawn(c.env, version)) fail(409, 'release_withdrawn');
  // The local stack (scripts/dev.mjs) deploys the stub instance server, not images.
  const image = c.env.LOCAL_DEV === '1' && c.env.RELEASE_IMAGE_CHECK === 'off' ? { status: 'ok' as const } : await checkImage(version, deps().fetch, imageSources(c.env).worca);
  if (image.status === 'missing') fail(422, 'image_not_found');
  if (image.status === 'mismatch') return c.json({ error: 'image_version_mismatch', reports: image.label }, 422);
  // Returned, not thrown: the app's error handler turns 5xx exceptions into internal_error.
  if (image.status === 'unavailable') return c.json({ error: 'registry_unavailable' }, 502);
  const r = await enrollRelease(c.env, version, { by: me.id, source: 'manual', latest: 'always' });
  await c.env.DB.prepare('DELETE FROM release_holds WHERE version = ?').bind(version).run();
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.worca_version_set', targetType: 'setting', targetId: 'worca_version', details: { version, instances: r.instancesNotified } });
  return c.json({ ok: true, version, instancesNotified: r.instancesNotified });
});

/** Newest first; releases and candidates by version (D80), anything else after them by text. */
const versionDesc = (a: string, b: string): number =>
  isVersion(a) && isVersion(b) ? compareVersions(b, a) : isVersion(a) !== isVersion(b) ? (isVersion(a) ? -1 : 1) : a < b ? 1 : a > b ? -1 : 0;

interface ReleaseEntry {
  version: string;
  publishedAt: number | null;
  publishedBy: string | null;
  source: 'manual' | 'npm' | null;
  instances: number;
  latest: boolean;
  deployable: boolean;
  /** D80: a release candidate; `deployable` then means its release isn't out yet. */
  rc: boolean;
  withdrawn: { at: number; by: string | null; reason: string } | null;
}

/**
 * P10: every recorded release, newest version first, with how many instances run it. Versions
 * instances run that were never recorded (the built-in default) appear with publishedAt null.
 * `deployable` is false below MIN_HOSTED_WORCA_VERSION and for a withdrawn release (D77): listed for
 * the record, never deployed. Also the npm versions held back from enrollment and the settings.
 */
platformApp.get('/releases', requireCap('platform.view'), async (c) => {
  const [releases, counts, holds] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      `SELECT version, published_at AS publishedAt, published_by AS publishedBy, source,
              withdrawn_at AS withdrawnAt, withdrawn_by AS withdrawnBy, withdrawn_reason AS withdrawnReason FROM worca_releases`,
    ),
    c.env.DB.prepare('SELECT worca_version AS version, COUNT(*) AS n FROM instances WHERE worca_version IS NOT NULL GROUP BY worca_version'),
    c.env.DB.prepare('SELECT version, reason, detail, first_seen_at AS firstSeenAt, checked_at AS checkedAt FROM release_holds'),
  ]);
  const latest = await latestWorcaVersion(c.env);
  const pinnable = new Set((await releaseCandidates(c.env)).map((v) => v.version));
  const byVersion = new Map<string, ReleaseEntry>();
  const entry = (version: string) => {
    let e = byVersion.get(version);
    if (!e) {
      const rc = isRc(version);
      const deployable = rc ? rcRunsHosted(version) && pinnable.has(version) : runsHosted(version);
      byVersion.set(version, (e = { version, publishedAt: null, publishedBy: null, source: null, instances: 0, latest: version === latest, deployable, rc, withdrawn: null }));
    }
    return e;
  };
  for (const r of releases?.results ?? []) {
    const e = entry(String(r.version));
    Object.assign(e, { publishedAt: r.publishedAt ?? null, publishedBy: r.publishedBy ?? null, source: r.source ?? 'manual' });
    if (r.withdrawnAt != null) {
      e.withdrawn = { at: Number(r.withdrawnAt), by: (r.withdrawnBy as string | null) ?? null, reason: String(r.withdrawnReason ?? '') };
      e.deployable = false;
    }
  }
  for (const r of counts?.results ?? []) entry(String(r.version)).instances = Number(r.n);
  entry(latest);
  const list = [...byVersion.values()].sort((a, b) => versionDesc(a.version, b.version));
  const held = (holds?.results ?? [])
    .filter((h) => !byVersion.get(String(h.version))?.publishedAt)
    .map((h) => ({ version: String(h.version), reason: String(h.reason), reports: h.reason === 'label_mismatch' ? String(h.detail ?? '') || null : null, firstSeenAt: Number(h.firstSeenAt), checkedAt: Number(h.checkedAt) }))
    .sort((a, b) => versionDesc(a.version, b.version));
  return c.json({ latest, releases: list, held, settings: await releaseSettings(c.env) });
});

const versionParam = (c: Context<AppContext>): string => {
  const v = c.req.param('version') ?? '';
  if (!isVersion(v)) fail(404, 'release_not_found');
  return v;
};

/**
 * D77: withdraws a release (a vulnerability, a bad build). Nothing is created, upgraded or
 * downgraded to it any more and automatic enrollment never brings it back; instances that run it
 * keep running and their org admins are emailed the reason. When it was the latest, the newest
 * release left takes its place; 409 `last_release` when none would be left.
 */
platformApp.post('/releases/:version/withdraw', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const version = versionParam(c);
  const { reason } = await parseJson(c, z.object({ reason: z.string().trim().min(1).max(500) }));
  const r = await withdrawRelease(c.env, version, me, reason);
  if (!r.ok) fail(r.error === 'release_not_found' ? 404 : 409, r.error);
  return c.json(r);
});

/** D77: undoes a withdrawal. The release is deployable again, and the latest again when newest. */
platformApp.post('/releases/:version/restore', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const version = versionParam(c);
  const r = await restoreRelease(c.env, version, me);
  if (!r.ok) fail(r.error === 'release_not_found' ? 404 : 409, r.error);
  return c.json(r);
});

/** D77: automatic enrollment on or off, and how long automatic updates wait after a release. */
platformApp.put('/release-settings', requireCap('system.settings'), async (c) => {
  const me = await staff(c);
  const body = await parseJson(c, z.object({ autoEnroll: z.boolean(), soakHours: z.number().int().min(0).max(MAX_SOAK_HOURS) }));
  const from = await releaseSettings(c.env);
  await setReleaseSettings(c.env, body);
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.release_settings_set', targetType: 'setting', targetId: 'releases', details: { ...body, fromAutoEnroll: from.autoEnroll, fromSoakHours: from.soakHours } });
  return c.json({ ok: true, settings: body });
});

const codeBody = z.object({
  tier: z.string().min(1).max(40).default('free'),
  uses: z.number().int().min(1).max(1000).default(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
  // Staff-written, e.g. who the code is for: encrypted with the creator's user key.
  note: z.string().trim().max(200).optional(),
});

/** The code is shown once; only its hash is stored (D49). */
platformApp.post('/registration/codes', requireCap('registration.codes'), async (c) => {
  const me = await staff(c);
  const body = await parseJson(c, codeBody);
  const made = await createRegistrationCode(c.env, { createdBy: me, tier: body.tier, uses: body.uses, expiresInDays: body.expiresInDays, note: body.note });
  return c.json({ code: made.code, id: made.id, tier: made.tier, usesLeft: made.uses, usesTotal: made.uses, note: body.note || null, expiresAt: made.expiresAt }, 201);
});

platformApp.get('/registration/codes', requireCap('registration.codes'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT code_hash AS id, created_by AS createdBy, tier, uses_left AS usesLeft, uses_total AS usesTotal, note,
            expires_at AS expiresAt, created_at AS createdAt
     FROM registration_codes ORDER BY created_at DESC`,
  ).all<{ id: string; createdBy: string | null; note: string | null } & Record<string, unknown>>();
  const codes = [];
  for (const r of rows.results) {
    // Null once the creator's key is gone (their account deleted, D59).
    const note = r.note && r.createdBy ? await tryDecrypt(c.env, codeNoteField(r.id, r.createdBy), r.note) : null;
    codes.push({ ...r, note });
  }
  return c.json({ codes });
});

platformApp.delete('/registration/codes/:id', requireCap('registration.codes'), async (c) => {
  const me = await staff(c);
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM registration_codes WHERE code_hash = ?').bind(id).run();
  if (!res.meta.changes) fail(404, 'not_found');
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.code_revoked', targetType: 'code', targetId: id.slice(0, 16) });
  return c.json({ ok: true });
});

// ---- waitlist (D25) ---------------------------------------------------------------------------

/** Pending accounts: ids and dates only; the address is opened one at a time when approving. */
/**
 * The waiting accounts with name and address: approvers need to know whom they let in. Each
 * listing is audited (`platform.waitlist_viewed`, with the count only), like support lookups.
 */
platformApp.get('/waitlist', requireCap('waitlist.manage'), async (c) => {
  const me = await staff(c);
  const rows = await c.env.DB.prepare("SELECT id, createdAt, emailVerified FROM user WHERE status = 'pending' ORDER BY createdAt LIMIT 500").all<{
    id: string;
    createdAt: string;
    emailVerified: number;
  }>();
  const pending = [];
  for (const r of rows.results) {
    const profile = await userProfile(c.env, r.id);
    pending.push({ ...r, name: profile?.name ?? null, email: profile?.email ?? null });
  }
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.waitlist_viewed', targetType: 'system', targetId: 'waitlist', details: { count: pending.length } });
  return c.json({ pending });
});

platformApp.post('/waitlist/:userId/approve', requireCap('waitlist.manage'), async (c) => {
  const me = await staff(c);
  const userId = c.req.param('userId');
  // Through the auth module, which also records registeredVia 'approved' so the account may
  // create an org (auth/registration.ts canCreateOrganization). Imported lazily: auth/index
  // pulls in modules that import tenancy.
  const { approveWaitlistedUser } = await import('../auth/index');
  if (!(await approveWaitlistedUser(c.env, userId))) fail(404, 'not_found');
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.waitlist_approved', targetType: 'user', targetId: userId });
  await notifyUsers(c.env, [userId], 'Your Worca account is ready', `Your account has been approved. Sign in at ${c.env.APP_ORIGIN}/sign-in`);
  return c.json({ ok: true });
});

/** Rejecting deletes the pending account outright (D29, D59); nothing of theirs is kept. */
platformApp.post('/waitlist/:userId/reject', requireCap('waitlist.manage'), async (c) => {
  const me = await staff(c);
  const userId = c.req.param('userId');
  const row = await c.env.DB.prepare("SELECT 1 FROM user WHERE id = ? AND status = 'pending'").bind(userId).first();
  if (!row) fail(404, 'not_found');
  await auditPlatform(c.env, { actorId: me.id, actorRole: me.role, action: 'platform.waitlist_rejected', targetType: 'user', targetId: userId });
  await purgeUser(c.env, userId, { id: me.id, role: me.role === 'superadmin' ? 'superadmin' : 'admin' });
  return c.json({ ok: true });
});

// ---- platform audit log -----------------------------------------------------------------------

/** P9: filters before, limit, actorId, action (prefix) and category, as the org log (audit.ts). */
platformApp.get('/audit', requireCap('audit.view'), async (c) => {
  const entries = await readPlatformAudit(c.env, parseAuditQuery(c.req.query()));
  const failures = await c.env.KV.get(`audit:failures:${new Date().toISOString().slice(0, 10)}`);
  return c.json({ entries, lostWritesToday: Number(failures ?? 0) });
});

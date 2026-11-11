// What other modules call on instances (docs/internal-apis.md "instances"), plus the helpers the
// routes, heartbeat, Workflow and crons share.
import { HTTPException } from 'hono/http-exception';
import type { InstanceStatus } from '../../shared/contracts';
import type { Env } from '../env';
import { gate } from '../gate-client';
import type { FieldContext } from '../keys-api';
import { instanceSettings } from '../providers';
import type { ComputeRef, EdgeRef, RemoteAccess } from '../providers/types';
import { deps, type AuditOrgEntry, type AuditPlatformEntry } from './deps';
import { compareVersions, isMicroUpdate, isMinorUpdate, isSemver } from './images';
import { finishOp, recordOpStart, setOpWorkflowId } from './progress';
import { computeSizes, type ComputeSize } from './sizes';
import { siteOf, type Site } from '../../shared/site';

export interface InstanceRow {
  id: string;
  org_id: string;
  slug: string;
  key_slug: string;
  display_name: string;
  status: InstanceStatus;
  worca_version: string | null;
  available_version: string | null;
  compute_ref: string | null;
  edge_ref: string | null;
  cpu: number | null;
  memory_mb: number | null;
  volume_gb: number | null;
  stopped_reason: string | null;
  stopped_by: string | null;
  heartbeat_cred_hash: string | null;
  heartbeat_cred_hash_prev: string | null; // migration 0024 (D74): the credential before a rotation, until the first new beat
  heartbeat_cred_prev_until: number | null; // and never after this (ms)
  secrets_rotated_at: number | null; // when the last rotation finished
  health: string | null;
  last_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  pending_op: 'wake' | 'lift' | 'suspend' | 'reconfigure' | 'rotate' | 'refresh' | null;
  target_version: string | null;
  last_error: string | null;
  health_since: number | null;
  compute_facts: string | null; // JSON ComputeFacts (compute-facts.ts)
  compute_facts_at: number | null;
  auto_update: 'micro' | 'off'; // migration 0020; with auto_update_minor, the mode autoUpdateModeOf reads
  auto_update_minor: number; // migration 0025 (D75): 1 = minor releases too (only with 'micro')
  auto_update_failed_version: string | null;
  terminal_remote: number; // migration 0022 (D72): 1 = WORCA_TERMINAL_REMOTE=1
  actions_remote: number; // 1 = WORCA_ACTIONS_REMOTE=1
  remote_pending: number; // 1 = not yet known to be applied on the worca service
  egress_mode: 'open' | 'block' | 'allow' | null; // migration 0023 (D73): the override's mode; NULL = follows the org's policy
  egress_hosts: string | null; // the override's lists, encrypted JSON (egress-api.ts)
  egress_version: number; // moves on whenever the effective policy may have changed
  egress_pending: number; // 1 = the effective policy is not yet known to be applied on the worca service
  deployed_images: string | null; // migration 0026 (D76): JSON images of the last deploy; NULL = from before it
  compute_size: string; // migration 0028 (D78): a size id (sizes.ts); cpu and memory_mb follow it
  size_pending: number; // 1 = the size is not yet known to be applied at the compute provider
  git_settings: string | null; // migration 0029 (D79): the git configuration, encrypted JSON (git-api.ts); NULL = none
  git_version: number; // 0 = never set from the console (its git variables are left alone)
  git_pending: number; // 1 = not yet known to be applied at the compute provider
  git_broker_applied: string | null; // hash of the broker git variables its running deployment has (git-api.ts brokerGitHash)
  provider_settings?: string | null; // {"provider", "values"}: the instance's provider settings (0032)
}

/**
 * Automatic updates (D26 as amended, D75), installed while the instance is idle: 'micro' takes x.y.Z
 * releases, 'minor' also x.Y.0 ones (any newer release of the same major), 'off' none.
 */
export const AUTO_UPDATE_MODES = ['micro', 'minor', 'off'] as const;
export type AutoUpdateMode = (typeof AUTO_UPDATE_MODES)[number];

/** The mode as the API shows it, from the two columns (auto_update, auto_update_minor). */
export function autoUpdateModeOf(row: Pick<InstanceRow, 'auto_update' | 'auto_update_minor'>): AutoUpdateMode {
  if (row.auto_update !== 'micro') return 'off';
  return row.auto_update_minor ? 'minor' : 'micro';
}
/** The same in SQL, over an instances row. */
export const AUTO_UPDATE_MODE_SQL = `CASE WHEN auto_update <> 'micro' THEN 'off' WHEN auto_update_minor = 1 THEN 'minor' ELSE 'micro' END`;
/** The two columns a mode is stored as. */
export function autoUpdateColumns(mode: AutoUpdateMode): { auto_update: 'micro' | 'off'; auto_update_minor: 0 | 1 } {
  return mode === 'off' ? { auto_update: 'off', auto_update_minor: 0 } : { auto_update: 'micro', auto_update_minor: mode === 'minor' ? 1 : 0 };
}

/** The modes that let the cron install `to` over `from` (none for a downgrade, a major or a prerelease). */
export function autoUpdateModesFor(from: string | null, to: string): AutoUpdateMode[] {
  if (isMicroUpdate(from, to)) return ['micro', 'minor'];
  if (isMinorUpdate(from, to)) return ['minor'];
  return [];
}

export type InstanceOp = 'create' | 'suspend' | 'wake' | 'upgrade' | 'stop' | 'lift' | 'delete' | 'reconfigure' | 'rotate' | 'refresh';

/** Params of InstanceOpsWorkflow. */
export interface OpParams {
  op: InstanceOp;
  instanceId: string;
  actorId?: string | null;
  /** upgrade: the version to deploy (D26). */
  version?: string;
  /** upgrade: started by the cron's automatic micro update, not by a tenant admin. refresh: by the cron (D76). */
  automatic?: boolean;
  /** rotate: wait this long before starting, so a rotation of every instance is spread out (D74). */
  staggerMs?: number;
}

export async function getInstance(env: Env, id: string): Promise<InstanceRow | null> {
  return env.DB.prepare(`SELECT * FROM instances WHERE id = ?`).bind(id).first<InstanceRow>();
}

export function parseComputeRef(row: Pick<InstanceRow, 'compute_ref'>): ComputeRef | null {
  return row.compute_ref ? (JSON.parse(row.compute_ref) as ComputeRef) : null;
}

/** The compute ref with the instance's provider settings attached, as every provider call gets it (never stored with the ref). */
export function computeRefOf(env: Pick<Env, 'COMPUTE_PROVIDER'>, row: Pick<InstanceRow, 'compute_ref' | 'provider_settings'>): ComputeRef | null {
  const ref = parseComputeRef(row);
  return ref ? { ...ref, settings: instanceSettings(env, row.provider_settings) } : null;
}
export function parseEdgeRef(row: Pick<InstanceRow, 'edge_ref'>): EdgeRef | null {
  return row.edge_ref ? (JSON.parse(row.edge_ref) as EdgeRef) : null;
}

// ---- Slugs and hosts (D8, D9, D10) ----

/** Base32 without the look-alikes 0, 1, l, o: 32 symbols, so `byte & 31` is unbiased. */
const SLUG_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
export const SLUG_LENGTH = 10;
export const RESERVED_SLUGS = new Set(['www', 'api', 'status', 'mail']);

export function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  return [...bytes].map((b) => SLUG_ALPHABET[b & 31]).join('');
}

export function isValidSlug(s: string): boolean {
  return s.length === SLUG_LENGTH && [...s].every((ch) => SLUG_ALPHABET.includes(ch)) && !RESERVED_SLUGS.has(s);
}

/** Two fresh slugs that no instance uses as either its slug or its key slug. */
export async function reserveSlugs(env: Env): Promise<{ slug: string; keySlug: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomSlug();
    const keySlug = randomSlug();
    if (slug === keySlug || !isValidSlug(slug) || !isValidSlug(keySlug)) continue;
    const taken = await env.DB.prepare(
      `SELECT 1 FROM instances WHERE slug IN (?1, ?2) OR key_slug IN (?1, ?2) LIMIT 1`,
    )
      .bind(slug, keySlug)
      .first();
    if (!taken) return { slug, keySlug };
  }
  throw new Error('could not reserve unique slugs');
}

export function hostFor(env: Env, slug: string): string {
  return `${slug}.${env.INSTANCE_DOMAIN}`;
}

export function instanceUrl(env: Env, host: string): string {
  return `${env.INSTANCE_SCHEME}://${host}${env.INSTANCE_ORIGIN_SUFFIX}`;
}

/** Host (port stripped, any case) → instance; `kind` says whether it is worca or the key page (D9). */
export async function findInstanceByHost(
  env: Env,
  host: string,
): Promise<{ id: string; orgId: string; kind: 'worca' | 'keypage'; status: InstanceStatus } | null> {
  const h = host.trim().toLowerCase().replace(/:\d+$/, '');
  const suffix = `.${env.INSTANCE_DOMAIN.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!isValidSlug(label)) return null;
  const row = await env.DB.prepare(`SELECT id, org_id, slug, status FROM instances WHERE slug = ?1 OR key_slug = ?1`)
    .bind(label)
    .first<{ id: string; org_id: string; slug: string; status: InstanceStatus }>();
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, kind: row.slug === label ? 'worca' : 'keypage', status: row.status };
}

/** Where the instance sends its heartbeats (WORCA_HEARTBEAT_URL). */
export function heartbeatUrl(env: Env): string {
  const url = new URL('/api/heartbeat', env.APP_ORIGIN);
  // Node (the stub) can't resolve *.localhost everywhere; the control plane doesn't route by host.
  if (env.LOCAL_DEV === '1' && url.hostname.endsWith('localhost')) url.hostname = '127.0.0.1';
  return url.toString();
}

/** Local development: the gate forwards to the stub server instead of the hostname (HostEntry.upstream). */
export function localUpstream(env: Env): string | undefined {
  if (env.COMPUTE_PROVIDER !== 'fake' || !env.STUB_ADMIN_URL) return undefined;
  return new URL(env.STUB_ADMIN_URL).origin;
}

// ---- Display name (encrypted with the org key, internal-apis.md field contexts) ----

function nameContext(orgId: string, instanceId: string): FieldContext {
  return { table: 'instances', column: 'display_name', rowId: instanceId, owner: { type: 'org', id: orgId } };
}

export function encryptDisplayName(env: Env, orgId: string, instanceId: string, name: string): Promise<string> {
  return deps().getKeyRing(env).encrypt(nameContext(orgId, instanceId), name);
}

/** Empty string when the org's key is gone (org deletion under way). */
export async function decryptDisplayName(env: Env, row: Pick<InstanceRow, 'id' | 'org_id' | 'display_name'>): Promise<string> {
  try {
    return await deps().getKeyRing(env).decrypt(nameContext(row.org_id, row.id), row.display_name);
  } catch (err) {
    console.error(JSON.stringify({ at: 'instances.decryptDisplayName', id: row.id, message: (err as Error).message }));
    return '';
  }
}

// ---- Workflow start ----

type OpStarter = (env: Env, params: OpParams) => Promise<string>;
let opStarter: OpStarter | null = null;

/** Tests only: capture started operations instead of running the Workflow. */
export function setOpStarter(fn?: OpStarter): void {
  opStarter = fn ?? null;
}

/**
 * Starts InstanceOpsWorkflow and records the operation in instance_ops (progress.ts) first, so
 * the Workflow's first step finds its row by the Workflow id.
 */
export async function startOp(env: Env, params: OpParams): Promise<string> {
  const opId = crypto.randomUUID();
  if (opStarter) {
    await recordOpStart(env, opId, params, null);
    try {
      const id = await opStarter(env, params);
      await setOpWorkflowId(env, opId, id);
      return id;
    } catch (err) {
      await finishOp(env, opId, params.op, { error: err });
      throw err;
    }
  }
  const id = `${params.op}-${params.instanceId}-${Date.now().toString(36)}`;
  await recordOpStart(env, opId, params, id);
  try {
    await env.INSTANCE_OPS.create({ id, params });
  } catch (err) {
    await finishOp(env, opId, params.op, { error: err });
    throw err;
  }
  return id;
}

type OpRestarter = (env: Env, workflowId: string) => Promise<void>;
let opRestarter: OpRestarter | null = null;

/** Tests only: capture restarts instead of calling the Workflow binding. */
export function setOpRestarter(fn?: OpRestarter): void {
  opRestarter = fn ?? null;
}

/** Restarts a Workflow run from the top; finished steps return their cached results. */
export async function restartWorkflow(env: Env, workflowId: string): Promise<void> {
  if (opRestarter) return opRestarter(env, workflowId);
  const instance = await env.INSTANCE_OPS.get(workflowId);
  await instance.restart();
}

// ---- Upgrade start (D26) ----

/**
 * Moves a running instance with no pending operation to `upgrading` and starts the upgrade
 * Workflow; false when the instance isn't running or something else is under way. The upgrade route
 * (a tenant admin) and the automatic micro update (crons, actor `system`) both start here. An
 * automatic start also requires the instance's automatic updates to still cover the jump (a minor
 * one needs 'minor', autoUpdateModesFor), checked in the same write. A downgrade (a
 * target older than the running version) records the version left in auto_update_failed_version,
 * so automatic updates don't bring it straight back (auto-update.ts skips versions not newer).
 */
export async function startUpgrade(
  env: Env,
  row: Pick<InstanceRow, 'id' | 'org_id' | 'worca_version'> & { auto_update_failed_version?: string | null },
  target: string,
  actor: { actorId: string | null; actorScope: 'tenant' | 'system'; automatic?: boolean; details?: Record<string, unknown> },
): Promise<boolean> {
  const automatic = !!actor.automatic;
  const left = row.worca_version;
  const prevSkip = row.auto_update_failed_version ?? null;
  const downgrade = !automatic && isSemver(left) && compareVersions(target, left) < 0;
  const skip = downgrade && !(isSemver(prevSkip) && compareVersions(prevSkip, left) >= 0) ? left : prevSkip;
  const modes = automatic ? autoUpdateModesFor(left, target) : [];
  if (automatic && !modes.length) return false;
  const res = await env.DB.prepare(
    `UPDATE instances SET status = 'upgrading', target_version = ?, last_error = NULL, updated_at = ?${downgrade ? ', auto_update_failed_version = ?' : ''}
      WHERE id = ? AND status = 'running' AND pending_op IS NULL${automatic ? ` AND ${AUTO_UPDATE_MODE_SQL} IN (${modes.map(() => '?').join(', ')})` : ''}`,
  )
    .bind(...(downgrade ? [target, Date.now(), skip, row.id] : [target, Date.now(), row.id]), ...modes)
    .run();
  if (!res.meta.changes) return false;
  await gate(env).setStatus(row.id, 'upgrading');
  await startOp(env, { op: 'upgrade', instanceId: row.id, actorId: actor.actorId, version: target, ...(automatic ? { automatic: true } : {}) });
  await auditOrgSafe(env, row.org_id, {
    actorId: actor.actorId, actorScope: actor.actorScope, action: 'instance.upgrade_started', targetType: 'instance', targetId: row.id,
    details: { from: row.worca_version, to: target, ...(automatic ? { automatic: true } : {}), ...actor.details },
  });
  return true;
}

// ---- Remote access in worca (D72) ----

/** The stored switches of a row, as the providers take them. */
export function remoteAccessOf(row: Pick<InstanceRow, 'terminal_remote' | 'actions_remote'>): RemoteAccess {
  return { terminalRemote: !!row.terminal_remote, actionsRemote: !!row.actions_remote };
}

export type RemoteAccessResult = 'unchanged' | 'applying' | 'saved';

/**
 * A tenant admin's change of the two switches. Running with nothing under way: stores them, marks
 * them pending and starts `reconfigure` (sets the variables, restarts worca), answering 'applying'.
 * Suspended or stopped with nothing under way: only stores them ('saved'); the next wake or lift
 * applies them. The same values, already applied: 'unchanged'. Anything else under way: 409
 * instance_busy; the values changed since `row` was read: 409 remote_access_changed. Audited as
 * `instance.remote_access_set` with old and new values.
 */
export async function changeRemoteAccess(
  env: Env,
  row: InstanceRow,
  access: { terminal: boolean; actions: boolean },
  actorId: string,
): Promise<RemoteAccessResult> {
  const from = { terminal: !!row.terminal_remote, actions: !!row.actions_remote };
  const same = from.terminal === access.terminal && from.actions === access.actions;
  // The caller decided (MFA needed or not) from `row`: every write below is compare-and-set on the
  // values read there, and a change made meanwhile (another admin) is refused, never overwritten.
  const ft = from.terminal ? 1 : 0;
  const fa = from.actions ? 1 : 0;
  const changedMeanwhile = async (): Promise<boolean> => {
    const now = await env.DB.prepare(`SELECT terminal_remote, actions_remote FROM instances WHERE id = ?`)
      .bind(row.id)
      .first<{ terminal_remote: number; actions_remote: number }>();
    return !now || !!now.terminal_remote !== from.terminal || !!now.actions_remote !== from.actions;
  };
  // Same values and applied: nothing to do. Same values but pending (a failed reconfigure) on a
  // running instance: try to apply them again.
  if (same && !(row.remote_pending && row.status === 'running')) {
    if (await changedMeanwhile()) throw new HTTPException(409, { message: 'remote_access_changed' });
    return 'unchanged';
  }
  const t = access.terminal ? 1 : 0;
  const a = access.actions ? 1 : 0;
  const now = Date.now();
  let result: RemoteAccessResult;
  const run = await env.DB.prepare(
    `UPDATE instances SET terminal_remote = ?, actions_remote = ?, remote_pending = 1, pending_op = 'reconfigure', updated_at = ?
      WHERE id = ? AND status = 'running' AND pending_op IS NULL AND terminal_remote = ? AND actions_remote = ?`,
  )
    .bind(t, a, now, row.id, ft, fa)
    .run();
  if (run.meta.changes) {
    try {
      await startOp(env, { op: 'reconfigure', instanceId: row.id, actorId });
    } catch (err) {
      // Not started: release the claim; the values stay saved and pending.
      await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'reconfigure'`).bind(row.id).run();
      throw err;
    }
    result = 'applying';
  } else {
    const saved = await env.DB.prepare(
      `UPDATE instances SET terminal_remote = ?, actions_remote = ?, remote_pending = 1, updated_at = ?
        WHERE id = ? AND status IN ('suspended', 'stopped') AND pending_op IS NULL AND terminal_remote = ? AND actions_remote = ?`,
    )
      .bind(t, a, now, row.id, ft, fa)
      .run();
    if (!saved.meta.changes) {
      throw new HTTPException(409, { message: (await changedMeanwhile()) ? 'remote_access_changed' : 'instance_busy' });
    }
    result = 'saved';
  }
  if (!same) {
    await auditOrgSafe(env, row.org_id, {
      actorId, actorScope: 'tenant', action: 'instance.remote_access_set', targetType: 'instance', targetId: row.id,
      details: { from, to: access, ...(result === 'saved' ? { appliesOnStart: true } : {}) },
    });
  }
  return result;
}

// ---- Compute size (D78) ----

export type SizeResult = RemoteAccessResult;

/**
 * A tenant admin's move to another compute size (the route checked the tier). Running with nothing
 * under way: stores it (with cpu and memory_mb), marks it pending and starts `reconfigure` (sets the
 * worca service's limits and parallelism, restarts worca): 'applying'. Suspended or stopped with
 * nothing under way: only stores it ('saved'); the next wake or lift applies it. The same size,
 * already applied: 'unchanged'. Anything else under way: 409 instance_busy; the size changed since
 * `row` was read: 409 size_changed. Audited as `instance.size_set`.
 */
export async function changeSize(env: Env, row: InstanceRow, size: ComputeSize, actorId: string): Promise<SizeResult> {
  const sizes = computeSizes(env);
  const from = sizes.of(row).id;
  const same = from === size.id;
  const changedMeanwhile = async (): Promise<boolean> => {
    const now = await env.DB.prepare(`SELECT compute_size FROM instances WHERE id = ?`).bind(row.id).first<{ compute_size: string }>();
    return !now || sizes.of(now).id !== from;
  };
  // Same size and applied: nothing to do. Same size but pending (a failed reconfigure) on a
  // running instance: try to apply it again.
  if (same && !(row.size_pending && row.status === 'running')) {
    if (await changedMeanwhile()) throw new HTTPException(409, { message: 'size_changed' });
    return 'unchanged';
  }
  const now = Date.now();
  const set = `compute_size = ?, cpu = ?, memory_mb = ?, size_pending = 1, updated_at = ?`;
  const vals = [size.id, size.vcpu, size.memoryMb, now] as const;
  let result: SizeResult;
  const run = await env.DB.prepare(
    `UPDATE instances SET ${set}, pending_op = 'reconfigure' WHERE id = ? AND status = 'running' AND pending_op IS NULL AND compute_size = ?`,
  )
    .bind(...vals, row.id, row.compute_size ?? from)
    .run();
  if (run.meta.changes) {
    try {
      await startOp(env, { op: 'reconfigure', instanceId: row.id, actorId });
    } catch (err) {
      // Not started: release the claim; the size stays saved and pending.
      await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'reconfigure'`).bind(row.id).run();
      throw err;
    }
    result = 'applying';
  } else {
    const saved = await env.DB.prepare(
      `UPDATE instances SET ${set} WHERE id = ? AND status IN ('suspended', 'stopped') AND pending_op IS NULL AND compute_size = ?`,
    )
      .bind(...vals, row.id, row.compute_size ?? from)
      .run();
    if (!saved.meta.changes) throw new HTTPException(409, { message: (await changedMeanwhile()) ? 'size_changed' : 'instance_busy' });
    result = 'saved';
  }
  if (!same) {
    await auditOrgSafe(env, row.org_id, {
      actorId, actorScope: 'tenant', action: 'instance.size_set', targetType: 'instance', targetId: row.id,
      details: { from, to: size.id, ...(result === 'saved' ? { appliesOnStart: true } : {}) },
    });
  }
  return result;
}

// ---- Audit and notifications: never fail the state change they follow ----

export async function auditOrgSafe(env: Env, orgId: string, entry: AuditOrgEntry): Promise<void> {
  try {
    await deps().auditOrg(env, orgId, entry);
  } catch (err) {
    console.error(JSON.stringify({ at: 'instances.auditOrg', action: entry.action, message: (err as Error).message }));
  }
}

export async function auditPlatformSafe(env: Env, entry: AuditPlatformEntry): Promise<void> {
  try {
    await deps().auditPlatform(env, entry);
  } catch (err) {
    console.error(JSON.stringify({ at: 'instances.auditPlatform', action: entry.action, message: (err as Error).message }));
  }
}

/** Emails every tenant admin of the org (D16, D26, creation). Returns how many were sent. */
export async function notifyOrgAdmins(env: Env, orgId: string, subject: string, text: string): Promise<number> {
  let sent = 0;
  try {
    const { results } = await env.DB.prepare(
      `SELECT u.id AS id, u.email AS email FROM member m JOIN "user" u ON u.id = m.userId
        WHERE m.organizationId = ? AND (',' || m.role || ',') LIKE '%,tenant_admin,%'`,
    )
      .bind(orgId)
      .all<{ id: string; email: string }>();
    const ring = deps().getKeyRing(env);
    for (const admin of results) {
      try {
        const to = ring.isCiphertext(admin.email)
          ? await ring.decrypt({ table: 'user', column: 'email', rowId: admin.id, owner: { type: 'user', id: admin.id } }, admin.email)
          : admin.email;
        await deps().sendEmail(env, { to, subject, text });
        sent++;
      } catch (err) {
        console.error(JSON.stringify({ at: 'instances.notify', userId: admin.id, message: (err as Error).message }));
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ at: 'instances.notify', orgId, message: (err as Error).message }));
  }
  return sent;
}

// ---- Platform actions (D16, D47, D60) and org deletion ----

export async function stopForAbuse(
  env: Env,
  instanceId: string,
  opts: { actorId: string; reason: string; actorRole?: string },
): Promise<void> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE instances SET status = 'stopped', stopped_reason = ?, stopped_by = ?, pending_op = NULL,
       target_version = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'suspended', 'upgrading')`,
  )
    .bind(opts.reason, opts.actorId, now, instanceId)
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: 'instance_not_stoppable' });
  const row = (await getInstance(env, instanceId))!;
  // The gate refuses at once; the Workflow then stops the services.
  await gate(env).setStatus(instanceId, 'stopped');
  await startOp(env, { op: 'stop', instanceId, actorId: opts.actorId });
  const details = { reason: opts.reason };
  await auditPlatformSafe(env, {
    actorId: opts.actorId, actorRole: opts.actorRole ?? null, action: 'instance.stopped', targetType: 'instance', targetId: instanceId,
    details: { orgId: row.org_id },
  });
  await auditOrgSafe(env, row.org_id, {
    actorId: opts.actorId, actorScope: 'platform', action: 'instance.stopped', targetType: 'instance', targetId: instanceId, details,
  });
  await notifyOrgAdmins(
    env,
    row.org_id,
    'Your Worca instance was stopped',
    `The instance ${instanceUrl(env, hostFor(env, row.slug))} was stopped by the platform for abuse.\n\nReason: ${opts.reason}${abuseContact(siteOf(env))}`,
  );
}

/** Who to write to about a stop for abuse, when the deployment names an address. */
function abuseContact(site: Site): string {
  return site.abuseEmail ? `\n\nReply to ${site.abuseEmail} if you think this is a mistake.` : '';
}

// ---- Credential rotation (D74) ----

/** What a rotation starts from: a running instance restarts, a suspended or stopped one only gets the new values. */
export const ROTATABLE: InstanceStatus[] = ['running', 'suspended', 'stopped'];

/** A rotation of every instance starts one every ROTATE_SPACING_MS, closer together if needed to start all within ROTATE_SPREAD_MS. */
export const ROTATE_SPACING_MS = 15_000;
export const ROTATE_SPREAD_MS = 10 * 60_000;

/**
 * Platform staff renew an instance's credentials (D74): claims it (running, suspended or stopped,
 * with nothing under way) and starts `rotate`. 409 instance_busy when something else is under way
 * or it is being created, upgraded or deleted. Audited in both logs.
 */
export async function rotateSecrets(
  env: Env,
  instanceId: string,
  opts: { actorId: string; actorRole?: string | null; staggerMs?: number; all?: boolean },
): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE instances SET pending_op = 'rotate', updated_at = ? WHERE id = ? AND status IN (${ROTATABLE.map(() => '?').join(', ')}) AND pending_op IS NULL`,
  )
    .bind(Date.now(), instanceId, ...ROTATABLE)
    .run();
  if (!res.meta.changes) {
    if (!(await getInstance(env, instanceId))) throw new HTTPException(404, { message: 'not_found' });
    throw new HTTPException(409, { message: 'instance_busy' });
  }
  try {
    await startOp(env, { op: 'rotate', instanceId, actorId: opts.actorId, ...(opts.staggerMs ? { staggerMs: opts.staggerMs } : {}) });
  } catch (err) {
    await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'rotate'`).bind(instanceId).run();
    throw err;
  }
  const row = (await getInstance(env, instanceId))!;
  const details = { status: row.status, ...(opts.all ? { all: true } : {}) };
  await auditPlatformSafe(env, {
    actorId: opts.actorId, actorRole: opts.actorRole ?? null, action: 'instance.rotate_started', targetType: 'instance', targetId: instanceId,
    details: { ...details, orgId: row.org_id },
  });
  await auditOrgSafe(env, row.org_id, {
    actorId: opts.actorId, actorScope: 'platform', action: 'instance.rotate_started', targetType: 'instance', targetId: instanceId, details,
  });
}

/**
 * Every instance's credentials at once (D74), e.g. after a provider breach: each one that can be
 * rotated now is claimed and started, spread out over at most ROTATE_SPREAD_MS. The others (being
 * created, upgraded or deleted, or with something else under way) are listed so staff can rotate
 * them once they are free.
 */
export async function rotateAll(
  env: Env,
  opts: { actorId: string; actorRole?: string | null },
): Promise<{ started: string[]; skipped: { id: string; status: InstanceStatus; pendingOp: InstanceRow['pending_op'] }[] }> {
  const { results } = await env.DB.prepare(`SELECT id, status, pending_op FROM instances ORDER BY created_at`).all<Pick<InstanceRow, 'id' | 'status' | 'pending_op'>>();
  const eligible = results.filter((r) => ROTATABLE.includes(r.status) && !r.pending_op);
  const spacing = eligible.length > 1 ? Math.min(ROTATE_SPACING_MS, Math.floor(ROTATE_SPREAD_MS / (eligible.length - 1))) : 0;
  const started: string[] = [];
  const skipped = results.filter((r) => !eligible.includes(r)).map((r) => ({ id: r.id, status: r.status, pendingOp: r.pending_op }));
  for (const r of eligible) {
    try {
      await rotateSecrets(env, r.id, { ...opts, staggerMs: started.length * spacing, all: true });
      started.push(r.id);
    } catch (err) {
      // Busy since the read (or gone): listed, the others go on.
      if (!(err instanceof HTTPException)) throw err;
      const now = await getInstance(env, r.id);
      if (now) skipped.push({ id: r.id, status: now.status, pendingOp: now.pending_op });
    }
  }
  await auditPlatformSafe(env, {
    actorId: opts.actorId, actorRole: opts.actorRole ?? null, action: 'instances.rotate_all_started', targetType: 'system', targetId: 'instances',
    details: { started: started.length, skipped: skipped.length },
  });
  return { started, skipped };
}

// ---- Component refresh (D76) ----

/**
 * Claims a running instance with nothing under way (pending_op = 'refresh') and starts `refresh`,
 * which redeploys the services whose image is out of date for its worca version (images.ts
 * needsRefresh; the caller checked). False when it isn't running or something else is under way.
 * A tenant admin starts it from the upgrade route, the cron for every running instance (auto-update.ts).
 */
export async function startRefresh(
  env: Env,
  row: Pick<InstanceRow, 'id' | 'org_id'>,
  actor: { actorId: string | null; actorScope: 'tenant' | 'system'; automatic?: boolean },
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE instances SET pending_op = 'refresh', updated_at = ? WHERE id = ? AND status = 'running' AND pending_op IS NULL`,
  )
    .bind(Date.now(), row.id)
    .run();
  if (!res.meta.changes) return false;
  try {
    await startOp(env, { op: 'refresh', instanceId: row.id, actorId: actor.actorId, ...(actor.automatic ? { automatic: true } : {}) });
  } catch (err) {
    await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'refresh'`).bind(row.id).run();
    throw err;
  }
  await auditOrgSafe(env, row.org_id, {
    actorId: actor.actorId, actorScope: actor.actorScope, action: 'instance.refresh_started', targetType: 'instance', targetId: row.id,
    ...(actor.automatic ? { details: { automatic: true } } : {}),
  });
  return true;
}

/** Only platform staff lift a stop (D47). Running again once the first heartbeat arrives. */
export async function liftStop(env: Env, instanceId: string, opts: { actorId: string; actorRole?: string }): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE instances SET pending_op = 'lift', updated_at = ? WHERE id = ? AND status = 'stopped' AND pending_op IS NULL`,
  )
    .bind(Date.now(), instanceId)
    .run();
  if (!res.meta.changes) throw new HTTPException(409, { message: 'instance_not_stopped' });
  const row = (await getInstance(env, instanceId))!;
  await startOp(env, { op: 'lift', instanceId, actorId: opts.actorId });
  await auditPlatformSafe(env, {
    actorId: opts.actorId, actorRole: opts.actorRole ?? null, action: 'instance.stop_lifted', targetType: 'instance', targetId: instanceId,
    details: { orgId: row.org_id },
  });
  await auditOrgSafe(env, row.org_id, {
    actorId: opts.actorId, actorScope: 'platform', action: 'instance.stop_lifted', targetType: 'instance', targetId: instanceId,
  });
}

/**
 * Starts the permanent deletion (D29) from any status, including stopped (D60). No confirmation
 * here: the route's confirmation handler and org deletion call it. Audits now, while the org key
 * still exists; the Workflow does the rest.
 */
export async function deleteInstanceNow(
  env: Env,
  instanceId: string,
  opts: { actorId: string | null; actorScope?: 'tenant' | 'platform' },
): Promise<void> {
  const row = await getInstance(env, instanceId);
  if (!row || row.status === 'deleting') return;
  const res = await env.DB.prepare(
    `UPDATE instances SET status = 'deleting', pending_op = NULL, updated_at = ? WHERE id = ? AND status <> 'deleting'`,
  )
    .bind(Date.now(), instanceId)
    .run();
  if (!res.meta.changes) return;
  await gate(env).setStatus(instanceId, 'deleting');
  await startOp(env, { op: 'delete', instanceId, actorId: opts.actorId });
  await auditOrgSafe(env, row.org_id, {
    actorId: opts.actorId, actorScope: opts.actorScope ?? 'tenant', action: 'instance.delete_started', targetType: 'instance', targetId: instanceId,
    details: { slug: row.slug },
  });
}

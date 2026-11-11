// Outbound network policy (D73): storage, the effective policy of an instance, what the worca service
// gets, and the two changes (the org's policy, an instance's override). Pure rules in egress.ts.
// docs/internal-apis.md "Outbound network policy", docs/instance-lifecycle.md "Outbound network policy".
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../env';
import type { FieldContext } from '../keys-api';
import type { WorcaSettings } from '../providers/types';
import { auditOrgSafe, remoteAccessOf, startOp, type InstanceRow } from './api';
import { deps } from './deps';
import { computeSizes } from './sizes';
import { egressVariables, OPEN_POLICY, platformEgressHosts, samePolicy, type EgressMode, type EgressPolicy } from './egress';

// ---- storage ------------------------------------------------------------------------------------

const orgHostsField = (orgId: string): FieldContext => ({
  table: 'org_egress_policies', column: 'hosts', rowId: orgId, owner: { type: 'org', id: orgId },
});
const instanceHostsField = (orgId: string, instanceId: string): FieldContext => ({
  table: 'instances', column: 'egress_hosts', rowId: instanceId, owner: { type: 'org', id: orgId },
});

interface Hosts {
  allow: string[];
  deny: string[];
}

/** Lists → stored column: NULL when both are empty, else the JSON encrypted with the org key. */
async function sealHosts(env: Env, ctx: FieldContext, p: EgressPolicy): Promise<string | null> {
  if (!p.allow.length && !p.deny.length) return null;
  return deps().getKeyRing(env).encrypt(ctx, JSON.stringify({ allow: p.allow, deny: p.deny } satisfies Hosts));
}

async function openHosts(env: Env, ctx: FieldContext, sealed: string | null): Promise<Hosts> {
  if (!sealed) return { allow: [], deny: [] };
  const h = JSON.parse(await deps().getKeyRing(env).decrypt(ctx, sealed)) as Partial<Hosts>;
  return { allow: Array.isArray(h.allow) ? h.allow : [], deny: Array.isArray(h.deny) ? h.deny : [] };
}

export interface OrgEgress {
  policy: EgressPolicy;
  /** 0 until the org's policy is first changed. */
  version: number;
}

interface OrgEgressRow {
  mode: EgressMode;
  hosts: string | null;
  version: number;
}

/** The org's policy; open with empty lists (version 0) until an admin changes it. */
export async function readOrgEgress(env: Env, orgId: string): Promise<OrgEgress> {
  const row = await env.DB.prepare(`SELECT mode, hosts, version FROM org_egress_policies WHERE org_id = ?`).bind(orgId).first<OrgEgressRow>();
  if (!row) return { policy: { ...OPEN_POLICY, allow: [], deny: [] }, version: 0 };
  const h = await openHosts(env, orgHostsField(orgId), row.hosts);
  return { policy: { mode: row.mode, ...h }, version: row.version };
}

type EgressCols = Pick<InstanceRow, 'id' | 'org_id' | 'egress_mode' | 'egress_hosts'>;

/** The instance's override, or null when it follows the org's policy. */
export async function readOverride(env: Env, row: EgressCols): Promise<EgressPolicy | null> {
  if (!row.egress_mode) return null;
  const h = await openHosts(env, instanceHostsField(row.org_id, row.id), row.egress_hosts);
  return { mode: row.egress_mode, ...h };
}

export interface InstanceEgress {
  effective: EgressPolicy;
  /** No override: the org's policy applies. */
  inherited: boolean;
  override: EgressPolicy | null;
  org: OrgEgress;
}

export async function instanceEgress(env: Env, row: EgressCols): Promise<InstanceEgress> {
  const [org, override] = await Promise.all([readOrgEgress(env, row.org_id), readOverride(env, row)]);
  return { effective: override ?? org.policy, inherited: !override, override, org };
}

// ---- what the worca service gets ----------------------------------------------------------------

/**
 * The values a step applied, so it can clear the pending flags only if nothing changed since
 * (Workflow step results hold these, never the host lists).
 */
export interface AppliedSettings {
  terminalRemote: boolean;
  actionsRemote: boolean;
  egressVersion: number;
  /** D78: the compute size id applied (absent in step results stored before it). */
  size?: string;
  /** D79: the git_version applied (absent when the platform doesn't manage the instance's git variables). */
  gitVersion?: number;
  /** D79: the broker's git variables as brokerGitHash, and whether the running broker lacks them (it restarts). */
  brokerHash?: string | null;
  brokerRestart?: boolean;
}

/**
 * Everything the reconfigure op sets on the worca service (D72, D73) for `row` as it is now. Takes
 * the row's egress_version before reading the org's policy: a change of the org's policy in between
 * moves egress_version on, so clearing egress_pending with the version taken here fails and the
 * change stays pending (never cleared without being applied).
 */
export async function worcaSettingsFor(env: Env, row: InstanceRow): Promise<{ settings: WorcaSettings; applied: AppliedSettings }> {
  const remote = remoteAccessOf(row);
  const { effective } = await instanceEgress(env, row);
  const size = computeSizes(env).of(row);
  return {
    settings: {
      ...remote,
      egress: egressVariables(effective, platformEgressHosts(env)),
      size: { cpu: size.vcpu, memoryMb: size.memoryMb, maxParallel: size.maxParallel, maxParallelScripts: size.maxParallelScripts },
      // D79: until a tenant admin saves git settings, members' own GitHub tokens are used by default.
      ...(row.git_version ? {} : { ghAsPerson: 'prefer' as const }),
    },
    applied: { ...remote, egressVersion: row.egress_version ?? 0, size: size.id, gitVersion: row.git_version ?? 0 },
  };
}

/** The values a step applied are now on the worca service, unless they changed meanwhile. */
export async function clearSettingsPending(env: Env, id: string, applied: AppliedSettings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE instances SET remote_pending = 0 WHERE id = ? AND terminal_remote = ? AND actions_remote = ?`)
      .bind(id, applied.terminalRemote ? 1 : 0, applied.actionsRemote ? 1 : 0),
    env.DB.prepare(`UPDATE instances SET egress_pending = 0 WHERE id = ? AND egress_version = ?`).bind(id, applied.egressVersion),
    ...(applied.size
      ? [env.DB.prepare(`UPDATE instances SET size_pending = 0 WHERE id = ? AND compute_size = ?`).bind(id, applied.size)]
      : []),
    ...(applied.gitVersion !== undefined
      ? [env.DB.prepare(`UPDATE instances SET git_pending = 0 WHERE id = ? AND git_version = ?`).bind(id, applied.gitVersion)]
      : []),
  ]);
}

// ---- the org's policy ---------------------------------------------------------------------------

export interface InheritCounts {
  /** Instances that follow the org's policy (no override), not being deleted. */
  inheriting: number;
  /** Of those, running ones: a change restarts their Worca. */
  inheritingRunning: number;
  overriding: number;
}

export async function inheritCounts(env: Env, orgId: string): Promise<InheritCounts & { overrides: { instanceId: string; mode: EgressMode }[] }> {
  const { results } = await env.DB.prepare(
    `SELECT id, status, egress_mode FROM instances WHERE org_id = ? AND status <> 'deleting' ORDER BY created_at`,
  )
    .bind(orgId)
    .all<{ id: string; status: string; egress_mode: EgressMode | null }>();
  const inheriting = results.filter((r) => !r.egress_mode);
  return {
    inheriting: inheriting.length,
    inheritingRunning: inheriting.filter((r) => r.status === 'running').length,
    overriding: results.length - inheriting.length,
    overrides: results.filter((r) => r.egress_mode).map((r) => ({ instanceId: r.id, mode: r.egress_mode! })),
  };
}

export interface OrgEgressResult {
  result: 'unchanged' | 'saved';
  version: number;
  /** Instances whose Worca restarts now to apply it, and their ids (the console watches them). */
  applying: number;
  applyingIds: string[];
  /** Instances that get it on their next start (asleep, stopped, or busy right now). */
  pending: number;
}

/**
 * A tenant admin's change of the org's policy, decided (MFA or not) on `current`, which the caller
 * read at the version the client based its change on. Compare-and-set on that version (409
 * egress_changed). In the same transaction every instance that follows the org's policy is marked
 * pending (and its egress_version moved on), and the running ones with nothing under way are claimed
 * for a `reconfigure`; instances with an override are untouched. Audited as `org.egress_updated`.
 */
export async function changeOrgEgress(
  env: Env,
  orgId: string,
  current: OrgEgress,
  next: EgressPolicy,
  actorId: string,
): Promise<OrgEgressResult> {
  if (samePolicy(current.policy, next)) return { result: 'unchanged', version: current.version, applying: 0, applyingIds: [], pending: 0 };
  const version = current.version + 1;
  const now = Date.now();
  const hosts = await sealHosts(env, orgHostsField(orgId), next);
  const { results: candidates } = await env.DB.prepare(
    `SELECT id FROM instances WHERE org_id = ? AND egress_mode IS NULL AND status = 'running' AND pending_op IS NULL`,
  )
    .bind(orgId)
    .all<{ id: string }>();
  // Every statement after the first runs only if the first one wrote this very change.
  const wrote = `EXISTS (SELECT 1 FROM org_egress_policies WHERE org_id = ? AND version = ? AND mode = ? AND hosts IS ? AND updated_at = ?)`;
  const w = [orgId, version, next.mode, hosts, now];
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO org_egress_policies (org_id, mode, hosts, version, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (org_id) DO UPDATE SET mode = excluded.mode, hosts = excluded.hosts, version = excluded.version, updated_at = excluded.updated_at
        WHERE org_egress_policies.version = ?`,
    ).bind(orgId, next.mode, hosts, version, now, current.version),
    env.DB.prepare(
      `UPDATE instances SET egress_version = egress_version + 1, egress_pending = 1, updated_at = ?
        WHERE org_id = ? AND egress_mode IS NULL AND status <> 'deleting' AND ${wrote}`,
    ).bind(now, orgId, ...w),
    ...candidates.map((c) =>
      env.DB.prepare(
        `UPDATE instances SET pending_op = 'reconfigure' WHERE id = ? AND org_id = ? AND egress_mode IS NULL AND status = 'running' AND pending_op IS NULL AND ${wrote}`,
      ).bind(c.id, orgId, ...w),
    ),
  ]);
  if (!res[0]?.meta.changes) throw new HTTPException(409, { message: 'egress_changed' });
  const marked = res[1]?.meta.changes ?? 0;
  const claimed = candidates.filter((_, i) => res[i + 2]?.meta.changes);
  const applyingIds: string[] = [];
  for (const c of claimed) {
    try {
      await startOp(env, { op: 'reconfigure', instanceId: c.id, actorId });
      applyingIds.push(c.id);
    } catch (err) {
      // Not started: the claim goes, the change stays pending (applied on its next start).
      console.error(JSON.stringify({ at: 'instances.changeOrgEgress', instanceId: c.id, message: (err as Error).message }));
      await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'reconfigure'`).bind(c.id).run();
    }
  }
  const applying = applyingIds.length;
  const pending = Math.max(0, marked - applying);
  await auditOrgSafe(env, orgId, {
    actorId, actorScope: 'tenant', action: 'org.egress_updated', targetType: 'org', targetId: orgId,
    details: { from: current.policy, to: next, applying, pending },
  });
  return { result: 'saved', version, applying, applyingIds, pending };
}

// ---- an instance's override ---------------------------------------------------------------------

export type InstanceEgressResult = 'unchanged' | 'stored' | 'applying' | 'saved';

/**
 * A tenant admin sets the instance's override (`next`), or removes it (null) so the instance follows
 * the org's policy again. Decided (MFA or not) on `cur`, read with `row`; every write is
 * compare-and-set on the instance's egress_version and the org's policy version read there, so a
 * change made meanwhile (another admin, here or on the org's policy) is refused with 409
 * egress_changed, never overwritten.
 * - The same override, applied: 'unchanged'. The same override still pending on a running instance:
 *   applied again ('applying'), the retry after a failed reconfigure or a missed org change.
 * - The override changes but the effective policy doesn't (an override equal to the org's policy,
 *   or removing one that was), nothing pending: stored, nothing restarts ('stored').
 * - Running, nothing under way: stored, pending, `reconfigure` started ('applying').
 * - Suspended or stopped, nothing under way: stored, pending; the next wake or lift applies it ('saved').
 * - Anything else under way: 409 instance_busy.
 * Audited as `instance.egress_set` (override set or changed) or `instance.egress_reset` (removed).
 */
export async function changeInstanceEgress(
  env: Env,
  row: InstanceRow,
  cur: InstanceEgress,
  next: EgressPolicy | null,
  actorId: string,
): Promise<InstanceEgressResult> {
  const sameOverride = samePolicy(cur.override, next);
  const effectiveSame = samePolicy(cur.effective, next ?? cur.org.policy);
  const basedOn = row.egress_version ?? 0;
  const orgVersion = cur.org.version;
  const orgUnchanged = `(SELECT COALESCE(MAX(version), 0) FROM org_egress_policies WHERE org_id = ?) = ?`;
  const changedMeanwhile = async (): Promise<boolean> => {
    const now = await env.DB.prepare(
      `SELECT egress_version AS v, (SELECT COALESCE(MAX(version), 0) FROM org_egress_policies WHERE org_id = ?) AS ov FROM instances WHERE id = ?`,
    )
      .bind(row.org_id, row.id)
      .first<{ v: number; ov: number }>();
    return !now || now.v !== basedOn || now.ov !== orgVersion;
  };

  if (sameOverride && !(row.egress_pending && row.status === 'running')) {
    if (await changedMeanwhile()) throw new HTTPException(409, { message: 'egress_changed' });
    return 'unchanged';
  }
  const mode = next?.mode ?? null;
  const hosts = next ? await sealHosts(env, instanceHostsField(row.org_id, row.id), next) : null;
  const set = `egress_mode = ?, egress_hosts = ?, egress_version = ?, updated_at = ?`;
  const vals = [mode, hosts, basedOn + 1, Date.now()];
  const cas = `id = ? AND egress_version = ? AND ${orgUnchanged}`;
  const casVals = [row.id, basedOn, row.org_id, orgVersion];
  let result: InstanceEgressResult;

  if (!sameOverride && effectiveSame && !row.egress_pending) {
    const res = await env.DB.prepare(`UPDATE instances SET ${set} WHERE ${cas} AND status <> 'deleting'`).bind(...vals, ...casVals).run();
    if (!res.meta.changes) throw new HTTPException(409, { message: (await changedMeanwhile()) ? 'egress_changed' : 'instance_busy' });
    result = 'stored';
  } else {
    const run = await env.DB.prepare(
      `UPDATE instances SET ${set}, egress_pending = 1, pending_op = 'reconfigure' WHERE ${cas} AND status = 'running' AND pending_op IS NULL`,
    )
      .bind(...vals, ...casVals)
      .run();
    if (run.meta.changes) {
      try {
        await startOp(env, { op: 'reconfigure', instanceId: row.id, actorId });
      } catch (err) {
        // Not started: release the claim; the policy stays saved and pending.
        await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'reconfigure'`).bind(row.id).run();
        throw err;
      }
      result = 'applying';
    } else {
      const saved = await env.DB.prepare(
        `UPDATE instances SET ${set}, egress_pending = 1 WHERE ${cas} AND status IN ('suspended', 'stopped') AND pending_op IS NULL`,
      )
        .bind(...vals, ...casVals)
        .run();
      if (!saved.meta.changes) throw new HTTPException(409, { message: (await changedMeanwhile()) ? 'egress_changed' : 'instance_busy' });
      result = 'saved';
    }
  }
  if (!sameOverride) {
    await auditOrgSafe(env, row.org_id, {
      actorId, actorScope: 'tenant', action: next ? 'instance.egress_set' : 'instance.egress_reset', targetType: 'instance', targetId: row.id,
      // null: the org's policy (from: it had none; to: it follows the org's policy again).
      details: { from: cur.override, to: next, ...(result === 'saved' ? { appliesOnStart: true } : {}) },
    });
  }
  return result;
}

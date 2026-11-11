// The instance operations as plain async functions over a StepRunner. InstanceOpsWorkflow runs them
// with Workflow steps (durable, retried); unit tests run them with an immediate runner.
// architecture.md "Creating an instance"; instance-lifecycle.md for the rest.
import { NonRetryableError } from 'cloudflare:workflows';
import type { InstanceStatus } from '../../shared/contracts';
import type { Env } from '../env';
import { gate } from '../gate-client';
import { sha256Hex } from '../keys-api';
import { computeRegion, instanceSettings, tunnelOrigins, type Providers } from '../providers';
import type { ComputeRef, EdgeRef, InstanceSpec, InstanceVariables } from '../providers/types';
import {
  auditOrgSafe,
  auditPlatformSafe,
  decryptDisplayName,
  getInstance,
  heartbeatUrl,
  hostFor,
  instanceUrl,
  localUpstream,
  notifyOrgAdmins,
  computeRefOf,
  parseEdgeRef,
  ROTATABLE,
  type InstanceOp,
  type InstanceRow,
  type OpParams,
} from './api';
import { refreshComputeFacts } from './compute-facts';
import { clearSettingsPending, worcaSettingsFor, type AppliedSettings } from './egress-api';
import { brokerNeedsRestart, gitApplyFor, markBrokerApplied } from './git-api';
import { enterStep, finishOp, leaveStep } from './progress';
import { computeSizes } from './sizes';
import {
  compareVersions,
  imageSources,
  imagesFor,
  imageTag,
  isMicroUpdate,
  isPublishedVersion,
  isVersion,
  latestWorcaVersion,
  needsRefresh,
  outdatedServices,
  parseDeployedImages,
  REFRESHABLE,
} from './images';

export interface StepRunner {
  /** Runs fn once, durably; `sensitive` keeps the output out of Workflow logs (secrets). */
  do<T>(name: string, fn: () => Promise<T>, opts?: { sensitive?: boolean }): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface OpsContext {
  env: Env;
  providers: Providers;
  steps: StepRunner;
  /** instance_ops row this run reports progress to (progress.ts); none: no progress rows. */
  opId?: string | null;
  /** How often and how long to wait for a heartbeat (default 10 s × 60 = 10 minutes). */
  pollMs?: number;
  maxPolls?: number;
}

export type OpResult = { ok: true; outcome: string } | { ok: false; outcome: string };

const ABORT = 'op_aborted';

/** The instance moved on (deleted, stopped…) while the operation ran: stop without retrying. */
function abort(why: string): never {
  throw new NonRetryableError(`${ABORT}: ${why}`);
}
export function isAborted(err: unknown): boolean {
  return String((err as Error)?.message ?? '').includes(ABORT);
}

async function loadIn(env: Env, id: string, statuses: InstanceStatus[], pendingOp?: InstanceRow['pending_op']): Promise<InstanceRow> {
  const row = await getInstance(env, id);
  if (!row) abort('instance gone');
  if (!statuses.includes(row.status)) abort(`status ${row.status}`);
  if (pendingOp !== undefined && row.pending_op !== pendingOp) abort(`pending ${row.pending_op}`);
  return row;
}

/** D76: the images the instance now runs with, written with the deploy that set them (or once a refresh is confirmed). */
async function saveImages(env: Env, id: string, images: InstanceSpec['image']): Promise<void> {
  await env.DB.prepare(`UPDATE instances SET deployed_images = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(images), Date.now(), id).run();
}

async function saveRefs(env: Env, id: string, refs: { compute?: ComputeRef; edge?: EdgeRef }): Promise<void> {
  if (refs.compute) {
    const { settings: _settings, ...ref } = refs.compute; // attached on read (computeRefOf), never stored
    await env.DB.prepare(`UPDATE instances SET compute_ref = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(ref), Date.now(), id).run();
  }
  if (refs.edge) {
    await env.DB.prepare(`UPDATE instances SET edge_ref = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(refs.edge), Date.now(), id).run();
  }
}

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The broker's vault key: 32 random bytes, standard base64 (what `worca broker secrets` prints). */
function randomVaultKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

function specFor(env: Env, row: InstanceRow, version: string): InstanceSpec {
  return {
    instanceId: row.id,
    orgId: row.org_id,
    host: hostFor(env, row.slug),
    keyHost: hostFor(env, row.key_slug),
    region: computeRegion(env),
    // D78: the worca service's ceiling is the instance's compute size.
    cpu: computeSizes(env).of(row).vcpu,
    memoryMb: computeSizes(env).of(row).memoryMb,
    volumeGb: row.volume_gb ?? 10,
    image: imagesFor(version, imageSources(env)),
    settings: instanceSettings(env, row.provider_settings),
  };
}

/**
 * A stop for abuse (api.ts stopForAbuse) preempts any operation, and its own op stops the services.
 * It can land after a step's state check but while the step's provider call starts or deploys
 * worca, which would bring worca back up after the stop. So every step that starts or deploys
 * reads the row again once the provider answered: stopped meanwhile means stop again, so the stop
 * wins (stopping is idempotent; the stop op may be doing the same). Leaves status, stopped_reason
 * and pending_op as the stop set them. A lift (`expectLift`) starts a stopped instance on purpose.
 */
async function stopIfStoppedMeanwhile(ctx: OpsContext, id: string, ref: ComputeRef, expectLift = false): Promise<boolean> {
  const row = await getInstance(ctx.env, id);
  if (!row || row.status !== 'stopped') return false;
  if (expectLift && row.pending_op === 'lift') return false;
  await ctx.providers.compute.stop(ref);
  return true;
}
const STOPPED_MEANWHILE: OpResult = { ok: false, outcome: 'stopped_meanwhile' };

type Probe = 'done' | 'wait' | 'gone';

/** Polls D1 until the heartbeat handler has moved the instance on, or the time is up. */
async function waitForBeat(
  ctx: OpsContext,
  id: string,
  label: string,
  probe: (row: InstanceRow | null) => Probe,
): Promise<Probe | 'timeout'> {
  const maxPolls = ctx.maxPolls ?? 60;
  for (let i = 0; i < maxPolls; i++) {
    const r = await ctx.steps.do(`${label}: check`, async () => probe(await getInstance(ctx.env, id)));
    if (r !== 'wait') return r;
    await ctx.steps.sleep(`${label}: wait`, ctx.pollMs ?? 10_000);
  }
  return 'timeout';
}

// ---- create ----

async function createOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const { compute, edge } = ctx.providers;
  const id = p.instanceId;
  const spec = await steps.do('load', async () => {
    const row = await loadIn(env, id, ['creating']);
    return specFor(env, row, await latestWorcaVersion(env));
  });
  // Phases (progress.ts): compute (project), network (tunnel, DNS, gate hosts), starting
  // (variables, deploy), waiting (first heartbeat). The tunnel comes before the variables, which
  // carry its token; DNS and the gate hosts before the deploy, so the first beat finds them.
  // A delete can be confirmed while a step below is talking to a provider: its own steps read the
  // refs saved so far, so what the step in flight creates would be missed. Each provider step
  // saves its refs first and is then followed by an `overtaken` check: still `creating` there
  // means any later delete reads those refs; overtaken means `undo create` removes what this run
  // made (instance-lifecycle.md, "Delete during create").
  const made: Made = {};
  let ref = await steps.do('create project', async () => {
    await loadIn(env, id, ['creating']);
    const r = await compute.createProject(spec);
    await saveRefs(env, id, { compute: r });
    return r;
  });
  made.compute = ref;
  if (await overtaken(ctx, id, 'create project')) return undoCreate(ctx, spec, made);
  const tunnel = await steps.do(
    'create tunnel',
    async () => {
      await loadIn(env, id, ['creating']);
      const t = await edge.createTunnel(spec, tunnelOrigins(env));
      await saveRefs(env, id, { edge: { tunnelId: t.tunnelId, dnsRecordIds: [] } });
      return t;
    },
    { sensitive: true },
  );
  made.tunnelId = tunnel.tunnelId;
  if (await overtaken(ctx, id, 'create tunnel')) return undoCreate(ctx, spec, made);
  made.dnsRecordIds = await steps.do('add dns', async () => {
    await loadIn(env, id, ['creating']);
    const dnsRecordIds = await edge.addDns(spec, tunnel.tunnelId);
    await saveRefs(env, id, { edge: { tunnelId: tunnel.tunnelId, dnsRecordIds } });
    return dnsRecordIds;
  });
  if (await overtaken(ctx, id, 'add dns')) return undoCreate(ctx, spec, made);

  // The gate learns the hosts before the first heartbeat can arrive: the heartbeat handler moves
  // creating → running and tells the gate, so the gate must already know the instance by then.
  await steps.do('gate hosts', async () => {
    const upstream = localUpstream(env);
    const extra = upstream ? { upstream } : {};
    await gate(env).putHost(spec.host, { instanceId: id, kind: 'worca', ...extra });
    await gate(env).putHost(spec.keyHost, { instanceId: id, kind: 'keypage', ...extra });
    const row = await getInstance(env, id);
    await gate(env).setStatus(id, row?.status === 'running' ? 'running' : 'creating');
    return true;
  });
  made.gateHosts = true;
  if (await overtaken(ctx, id, 'gate hosts')) return undoCreate(ctx, spec, made);

  // Every secret is generated inside this one step and used only here: a retry generates a fresh
  // set and applies all of it again, and the step returns no secret, so nothing reaches the
  // Workflow's stored step results or logs. Only the heartbeat credential's hash is kept in D1;
  // the broker's secret and vault key live only in the instance's variables at the provider (D68), which later deploys,
  // upgrades and wakes leave untouched.
  const applied = await steps.do('set variables', async () => {
    const row = await loadIn(env, id, ['creating']);
    // Remote access (D72: off unless a tenant admin turns it on later) and the outbound network
    // policy (D73: the org's, as a new instance has no override yet).
    const { settings, applied } = await worcaSettingsFor(env, row);
    const credential = randomToken();
    await env.DB.prepare(`UPDATE instances SET heartbeat_cred_hash = ? WHERE id = ?`).bind(await sha256Hex(credential), id).run();
    const vars: InstanceVariables = {
      tunnelToken: tunnel.tunnelToken,
      allowedHosts: spec.host,
      identityIssuer: env.APP_ORIGIN,
      identityAudience: spec.host,
      keyPageAudience: spec.keyHost,
      heartbeatUrl: heartbeatUrl(env),
      heartbeatCredential: credential,
      brokerSecret: randomToken(),
      brokerVaultKey: randomVaultKey(),
      instanceUrl: instanceUrl(env, spec.host),
      keyPageUrl: instanceUrl(env, spec.keyHost),
      ...settings,
    };
    await compute.setVariables(ref, vars);
    return applied; // values and versions only, no secret
  });
  ref = await steps.do('deploy', async () => {
    await loadIn(env, id, ['creating']);
    const r = await compute.deploy(ref, spec.image);
    await saveRefs(env, id, { compute: r });
    await saveImages(env, id, spec.image);
    return r;
  });

  // The heartbeat handler moves creating → running on the first beat.
  const waited = await waitForBeat(ctx, id, 'first heartbeat', (row) =>
    !row ? 'gone' : row.status === 'running' ? 'done' : row.status === 'creating' ? 'wait' : 'gone',
  );
  if (waited === 'gone') return { ok: false, outcome: 'gone' };
  if (waited === 'timeout') {
    await steps.do('record no heartbeat', async () => {
      await env.DB.prepare(`UPDATE instances SET last_error = 'no_heartbeat', updated_at = ? WHERE id = ? AND status = 'creating'`)
        .bind(Date.now(), id)
        .run();
      await notifyCreation(env, id, false);
      return true;
    });
    return { ok: false, outcome: 'no_heartbeat' };
  }

  await steps.do('notify created', async () => {
    // worca reported in, so it runs with the variables set above. An org policy change since they
    // were read leaves egress_pending set (worcaSettingsFor).
    await clearSettingsPending(env, id, applied);
    await notifyCreation(env, id, true);
    return true;
  });
  await recordComputeFacts(ctx, id);
  return { ok: true, outcome: 'running' };
}

/** What a create run has made so far, for `undo create`. */
interface Made {
  compute?: ComputeRef;
  tunnelId?: string;
  dnsRecordIds?: string[];
  gateHosts?: boolean;
}

/**
 * True when a delete overtook the create: the row is gone or `deleting`. (`running` is fine: a
 * restarted create can see the first heartbeat early.) Its own step, so a replay doesn't re-decide.
 */
async function overtaken(ctx: OpsContext, id: string, after: string): Promise<boolean> {
  return ctx.steps.do(`${after}: overtaken?`, async () => {
    const row = await getInstance(ctx.env, id);
    return !row || row.status === 'deleting';
  });
}

/**
 * Removes what this create run made, after a delete overtook it. Every call is idempotent, so it is
 * harmless when the delete Workflow removes the same things too.
 */
async function undoCreate(ctx: OpsContext, spec: InstanceSpec, made: Made): Promise<OpResult> {
  const { env } = ctx;
  await ctx.steps.do('undo create', async () => {
    if (made.compute) await ctx.providers.compute.destroy(made.compute);
    if (made.dnsRecordIds?.length) await ctx.providers.edge.deleteDns(made.dnsRecordIds);
    if (made.tunnelId) await ctx.providers.edge.deleteTunnel(made.tunnelId);
    if (made.gateHosts) {
      await gate(env).deleteHost(spec.host);
      await gate(env).deleteHost(spec.keyHost);
      await gate(env).destroy(spec.instanceId);
    }
    return true;
  });
  return { ok: false, outcome: 'aborted' };
}

async function notifyCreation(env: Env, id: string, ok: boolean): Promise<void> {
  const row = await getInstance(env, id);
  if (!row) return;
  const name = await decryptDisplayName(env, row);
  const url = instanceUrl(env, hostFor(env, row.slug));
  await auditOrgSafe(env, row.org_id, {
    actorId: null, actorScope: 'platform', action: ok ? 'instance.created' : 'instance.create_failed', targetType: 'instance', targetId: id,
    details: ok ? { version: row.worca_version } : { error: row.last_error },
  });
  if (ok) {
    await notifyOrgAdmins(env, row.org_id, `Your Worca instance ${name} is ready`, `${name} is running at ${url}`);
  } else {
    await notifyOrgAdmins(
      env,
      row.org_id,
      `Your Worca instance ${name} could not be started`,
      `${name} (${url}) did not come up in time. You can delete it and create it again; we have been notified.`,
    );
  }
}

/** Records why creation failed so the console can show it (status stays `creating`). */
async function recordCreateFailure(ctx: OpsContext, id: string, err: unknown): Promise<void> {
  await ctx.steps.do('record failure', async () => {
    const message = String((err as Error)?.message ?? err).slice(0, 200);
    await ctx.env.DB.prepare(`UPDATE instances SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'creating'`)
      .bind(`create_failed: ${message}`, Date.now(), id)
      .run();
    await notifyCreation(ctx.env, id, false);
    return true;
  });
}

/**
 * Best effort: what the compute provider now reports for the instance (compute-facts.ts). Never throws, so it
 * can't fail or retry the operation; a failed read keeps the previous facts for the cron to renew.
 */
async function recordComputeFacts(ctx: OpsContext, id: string): Promise<void> {
  await ctx.steps.do('compute facts', async () => refreshComputeFacts(ctx.env, ctx.providers, id));
}

// ---- suspend / wake (D27, D48) ----

async function suspendOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  const ref = await steps.do('load', async () => computeRefOf(env, await loadIn(env, id, ['running'], 'suspend')));
  if (ref) await steps.do('stop services', async () => (await ctx.providers.compute.stop(ref), true));
  const changed = await steps.do('mark suspended', async () => {
    const res = await env.DB.prepare(
      `UPDATE instances SET status = 'suspended', pending_op = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND pending_op = 'suspend'`,
    )
      .bind(Date.now(), id)
      .run();
    if (!res.meta.changes) return false;
    await gate(env).setStatus(id, 'suspended');
    const row = await getInstance(env, id);
    if (row) await auditOrgSafe(env, row.org_id, { actorId: null, actorScope: 'platform', action: 'instance.suspended', targetType: 'instance', targetId: id });
    return true;
  });
  return { ok: changed, outcome: changed ? 'suspended' : 'skipped' };
}

/**
 * Starts the services; the first heartbeat sets `running` (heartbeat.ts), not this op. A service
 * whose image is out of date (D76: a newer cloudflared pinned while it slept) starts from the new
 * image, recorded once the new connector reported in.
 */
async function startAndWait(ctx: OpsContext, p: OpParams, from: 'suspended' | 'stopped', pending: 'wake' | 'lift'): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  let appliedOnStart: AppliedSettings | null = null;
  const { ref, apply, refresh, tunnelId } = await steps.do('load', async () => {
    const row = await loadIn(env, id, [from], pending);
    const refresh = needsRefresh(row, imageSources(env)) ? { version: row.worca_version!, kinds: outdatedServices(row, imageSources(env)) } : null;
    return { ref: computeRefOf(env, row), apply: settingsPending(row), refresh, tunnelId: parseEdgeRef(row)?.tunnelId ?? null };
  });
  const images = refresh ? imagesFor(refresh.version, imageSources(env)) : null;
  if (ref) {
    // Remote access (D72), the outbound network policy (D73), the size (D78) or git credentials (D79)
    // changed while it was down: set them first, and start worca (and the broker, when its git
    // variables changed) from its current configuration so the new values surely apply.
    const applied = apply ? await applyWorcaSettings(ctx, id, ref) : null;
    const started = await steps.do('start services', async () => {
      const opts = {
        ...(applied ? { worcaFromConfig: true } : {}),
        ...(applied?.brokerRestart ? { brokerFromConfig: true } : {}),
        ...(refresh && images ? { images: Object.fromEntries(refresh.kinds.map((k) => [k, images[k]])) } : {}),
      };
      const r = await ctx.providers.compute.start(ref, Object.keys(opts).length ? opts : undefined);
      await saveRefs(env, id, { compute: r });
      // D79: the broker started from its configuration, with the git variables just set.
      if (applied?.brokerRestart) await markBrokerApplied(env, id, applied.brokerHash ?? null);
      return !(await stopIfStoppedMeanwhile(ctx, id, r, pending === 'lift'));
    });
    if (!started) return STOPPED_MEANWHILE;
    if (applied) appliedOnStart = applied;
  }
  const waited = await waitForBeat(ctx, id, 'heartbeat', (row) =>
    !row ? 'gone' : row.status === 'running' ? 'done' : row.status === from && row.pending_op === pending ? 'wait' : 'gone',
  );
  if (waited === 'timeout') {
    // Give up so a later visit (or platform staff) can try again.
    await steps.do('record timeout', async () => {
      await env.DB.prepare(`UPDATE instances SET pending_op = NULL, last_error = ?, updated_at = ? WHERE id = ? AND status = ? AND pending_op = ?`)
        .bind(`${pending}_timeout`, Date.now(), id, from, pending)
        .run();
      return true;
    });
    return { ok: false, outcome: `${pending}_timeout` };
  }
  // Pending settings count as applied only once worca reported in from the new start.
  const applied = appliedOnStart;
  if (waited === 'done' && applied) await steps.do('mark applied', async () => (await clearSettingsPending(env, id, applied), true));
  // The new connector is recorded only once Cloudflare sees it; otherwise it stays out of date and
  // the cron's refresh tries again (auto-update.ts). The wake itself succeeded either way.
  if (waited === 'done' && ref && refresh && images && tunnelId) {
    if (await connectorRuns(ctx, tunnelId, imageTag(images.cloudflared))) {
      await steps.do('record images', async () => (await saveImages(env, id, images), true));
    }
  }
  return { ok: waited === 'done', outcome: waited === 'done' ? 'running' : 'gone' };
}

// ---- upgrade (D26) ----

async function upgradeOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  const { ref, previous, target, apply } = await steps.do('load', async () => {
    const row = await loadIn(env, id, ['upgrading']);
    const target = p.version ?? row.target_version;
    if (!target) abort('no target version');
    // Checked again here, before imagesFor(): only published versions select an image tag.
    // D80: a release candidate was allowed when the upgrade started (the route checks the org).
    if (!(await isPublishedVersion(env, target, row.available_version, { rc: true }))) {
      await env.DB.prepare(`UPDATE instances SET status = 'running', target_version = NULL, last_error = 'unknown_version', updated_at = ? WHERE id = ? AND status = 'upgrading'`)
        .bind(Date.now(), id)
        .run();
      await gate(env).setStatus(id, 'running');
      abort('unpublished version');
    }
    // The running version comes from heartbeats (instance-reported): only reuse it as a tag if well-formed.
    const previous = isVersion(row.worca_version) ? row.worca_version : await latestWorcaVersion(env);
    return { ref: computeRefOf(env, row), previous, target, apply: settingsPending(row) };
  });
  if (!ref) abort('no compute');
  // Settings not yet applied (D72, D73: saved while busy, or a failed reconfigure): the deploy below picks them up.
  const applied = apply ? await applyWorcaSettings(ctx, id, ref) : null;
  const deployed = await steps.do('deploy new version', async () => {
    await loadIn(env, id, ['upgrading']);
    const r = await ctx.providers.compute.deploy(ref, imagesFor(target, imageSources(env)));
    await saveRefs(env, id, { compute: r });
    await saveImages(env, id, imagesFor(target, imageSources(env)));
    // A deploy starts every service from its configuration: the broker has its git variables now (D79).
    if (applied?.brokerHash !== undefined) await markBrokerApplied(env, id, applied.brokerHash);
    return !(await stopIfStoppedMeanwhile(ctx, id, r));
  });
  if (!deployed) return STOPPED_MEANWHILE;
  // heartbeat.ts moves upgrading → running once a beat reports `target`.
  const waited = await waitForBeat(ctx, id, 'new version', (row) =>
    !row ? 'gone' : row.status === 'running' ? 'done' : row.status === 'upgrading' ? 'wait' : 'gone',
  );
  if (waited === 'gone') return { ok: false, outcome: 'gone' };
  if (waited === 'done') {
    // The new version reported in: it runs with the settings set before the deploy. (After a roll
    // back they stay pending: that deployment was never confirmed.)
    if (applied) await steps.do('mark applied', async () => (await clearSettingsPending(env, id, applied), true));
    await steps.do('notify upgraded', async () => {
      // A version picked below the running one is a downgrade (the version picker): say so.
      const what = isVersion(previous) && compareVersions(target, previous) < 0 ? `moved back to ${target}` : `upgraded to ${target}`;
      await notifyUpgrade(env, id, what, { from: previous, to: target, ...(p.automatic ? { automatic: true } : {}) });
      return true;
    });
    await recordComputeFacts(ctx, id);
    return { ok: true, outcome: 'upgraded' };
  }
  const rolledBack = await steps.do('roll back', async () => {
    const r = await ctx.providers.compute.deploy(ref, imagesFor(previous, imageSources(env)));
    await saveRefs(env, id, { compute: r });
    await saveImages(env, id, imagesFor(previous, imageSources(env)));
    if (await stopIfStoppedMeanwhile(ctx, id, r)) return false;
    const res = await env.DB.prepare(
      `UPDATE instances SET status = 'running', target_version = NULL, last_error = 'upgrade_timeout', updated_at = ? WHERE id = ? AND status = 'upgrading'`,
    )
      .bind(Date.now(), id)
      .run();
    if (res.meta.changes) await gate(env).setStatus(id, 'running');
    // An automatic micro update that failed is not tried again for this version (crons.ts).
    if (p.automatic) {
      await env.DB.prepare(`UPDATE instances SET auto_update_failed_version = ? WHERE id = ?`).bind(target, id).run();
    }
    await notifyUpgrade(env, id, `could not be upgraded to ${target} and was rolled back to ${previous}`, {
      from: previous, to: target, rolledBack: true, ...(p.automatic ? { automatic: true } : {}),
    });
    return true;
  });
  if (!rolledBack) return STOPPED_MEANWHILE;
  await recordComputeFacts(ctx, id);
  return { ok: false, outcome: 'rolled_back' };
}

async function notifyUpgrade(env: Env, id: string, what: string, details: Record<string, unknown>): Promise<void> {
  const row = await getInstance(env, id);
  if (!row) return;
  const name = await decryptDisplayName(env, row);
  await auditOrgSafe(env, row.org_id, {
    actorId: null, actorScope: 'platform', action: details.rolledBack ? 'instance.upgrade_rolled_back' : 'instance.upgraded',
    targetType: 'instance', targetId: id, details,
  });
  const url = instanceUrl(env, hostFor(env, row.slug));
  if (details.automatic) {
    const mail = automaticUpgradeMail(env, row, name, url, String(details.from), String(details.to), !!details.rolledBack);
    await notifyOrgAdmins(env, row.org_id, mail.subject, mail.text);
    return;
  }
  await notifyOrgAdmins(env, row.org_id, `Your Worca instance ${name} ${what}`, `${name} (${url}) ${what}.`);
}

/** The one mail of an automatic update's outcome (D26 as amended, D75), to the org's tenant admins. */
export function automaticUpgradeMail(
  env: Env,
  row: Pick<InstanceRow, 'id' | 'org_id'>,
  name: string,
  url: string,
  from: string,
  to: string,
  rolledBack: boolean,
): { subject: string; text: string } {
  const page = `${env.APP_ORIGIN}/o/${encodeURIComponent(row.org_id)}/instances/${encodeURIComponent(row.id)}`;
  const off = `To stop automatic updates, turn off "Automatic updates" on the instance page: ${page}`;
  // D75: a minor release can change how Worca stores its data, so a rolled back one says to check.
  const kind = isMicroUpdate(from, to) ? 'micro' : 'minor';
  if (rolledBack) {
    const check = kind === 'minor' ? `A minor release can change how Worca stores its data: check that ${name} works as before.\n\n` : '';
    return {
      subject: `The automatic update of Worca ${name} to ${to} was rolled back`,
      text:
        `Worca ${name} (${url}) was being updated from ${from} to ${to} automatically while it was idle. ` +
        `The new version did not report in, so it was rolled back to ${from} and keeps running as before.\n\n${check}` +
        `${to} won't be installed automatically again; a later release will be. You can still upgrade from the instance page when you choose.\n\n${off}`,
    };
  }
  return {
    subject: `Worca ${name} was updated to ${to}`,
    text:
      `Worca ${name} (${url}) was updated from ${from} to ${to}. ` +
      `This ${kind} release was installed automatically while the instance was idle: nothing was running or queued and nobody was using it.\n\n${off}`,
  };
}

// ---- settings on the worca service: remote access (D72), outbound network policy (D73), size (D78), git (D79) ----

/** Something a tenant admin changed is not yet known to be applied on the worca service. */
const settingsPending = (row: InstanceRow) => !!(row.remote_pending || row.egress_pending || row.size_pending || row.git_pending);

/**
 * Sets everything a tenant admin controls on the worca service, as the row says now (no deploy).
 * Returns what it applied, to clear the pending flags with once worca runs with it; the step's
 * stored result holds those values and versions only, never the host lists.
 */
async function applyWorcaSettings(ctx: OpsContext, id: string, ref: ComputeRef, suffix = ''): Promise<AppliedSettings> {
  return ctx.steps.do(`set worca settings${suffix}`, async () => {
    const row = await getInstance(ctx.env, id);
    if (!row) abort('instance gone');
    const { settings, applied } = await worcaSettingsFor(ctx.env, row);
    await ctx.providers.compute.setWorcaSettings(ref, settings);
    // D79: git credentials, once a tenant admin set them from the console. The variables (secrets)
    // stay inside this step; its result holds the version and a hash only.
    const git = await gitApplyFor(ctx.env, row);
    if (!git) return applied;
    await ctx.providers.compute.setGitSettings(ref, git.vars);
    return { ...applied, gitVersion: git.version, brokerHash: git.brokerHash, brokerRestart: brokerNeedsRestart(row, git.brokerHash) };
  });
}

/** Polls the provider until the worca deployment restartWorca made runs, fails, or the time is up. */
async function waitForWorcaDeployment(ctx: OpsContext, id: string, ref: ComputeRef, suffix: string): Promise<'running' | 'failed' | 'timeout' | 'gone'> {
  const maxPolls = ctx.maxPolls ?? 60;
  for (let i = 0; i < maxPolls; i++) {
    const r = await ctx.steps.do(`confirm restart: check${suffix}`, async () => {
      const row = await getInstance(ctx.env, id);
      if (!row || row.status !== 'running' || row.pending_op !== 'reconfigure') return 'gone' as const;
      const state = await ctx.providers.compute.worcaDeploymentState(ref);
      return state === 'starting' ? ('wait' as const) : state;
    });
    if (r !== 'wait') return r;
    await ctx.steps.sleep(`confirm restart: wait${suffix}`, ctx.pollMs ?? 10_000);
  }
  return 'timeout';
}

/** Rounds of a reconfigure when the settings change again while worca restarts (an org policy change). */
const RECONFIGURE_ROUNDS = 3;

/**
 * Applies the settings of a running instance (pending_op = 'reconfigure', claimed by the route that
 * changed them: remote access, the instance's override, or the org's policy it follows): set the
 * variables on the worca service, then a new worca deployment picks them up. Active runs pause and
 * resume (WORCA_AUTO_RESUME). The broker and cloudflared are not touched. Settings that changed
 * again meanwhile (an org policy change marks the instance pending without claiming it) are applied
 * in another round, up to RECONFIGURE_ROUNDS; after that they stay pending for the next start.
 */
async function reconfigureOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  let ref = await steps.do('load', async () => computeRefOf(env, await loadIn(env, id, ['running'], 'reconfigure')));
  if (!ref) abort('no compute');
  for (let round = 1; round <= RECONFIGURE_ROUNDS; round++) {
    const n = round === 1 ? '' : ` (${round})`;
    const applied = await applyWorcaSettings(ctx, id, ref, n);
    const from: ComputeRef = ref;
    const restarted = await steps.do(`restart worca${n}`, async () => {
      await loadIn(env, id, ['running'], 'reconfigure');
      const r = await ctx.providers.compute.restartWorca(from);
      await saveRefs(env, id, { compute: r });
      // Stopped meanwhile: the pending flags stay, so the lift applies the values.
      return (await stopIfStoppedMeanwhile(ctx, id, r)) ? null : r;
    });
    if (!restarted) return STOPPED_MEANWHILE;
    ref = restarted;
    if (applied.brokerRestart) {
      // D79: the members' GitHub sign-in changed: the key page restarts with it (worca keeps running).
      const withBroker: ComputeRef = ref;
      const r = await steps.do(`restart key page${n}`, async () => {
        await loadIn(env, id, ['running'], 'reconfigure');
        const r = await ctx.providers.compute.restartBroker(withBroker);
        await saveRefs(env, id, { compute: r });
        await markBrokerApplied(env, id, applied.brokerHash ?? null);
        return r;
      });
      ref = r;
    }
    // Only a deployment that runs applies them: a failed one leaves the provider running the previous
    // deployment with the previous variables. Failed or not confirmed in time: the op fails and the
    // settings stay pending (shown on the instance page; saving again retries).
    const deployed = await waitForWorcaDeployment(ctx, id, ref, n);
    if (deployed === 'gone') return { ok: false, outcome: 'skipped' };
    if (deployed !== 'running') throw new NonRetryableError(`reconfigure: the new worca deployment ${deployed === 'failed' ? 'failed' : 'did not start in time'}`);
    const state = await steps.do(`mark applied${n}`, async () => {
      await clearSettingsPending(env, id, applied);
      const res = await env.DB.prepare(
        `UPDATE instances SET pending_op = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND pending_op = 'reconfigure'
           AND remote_pending = 0 AND egress_pending = 0 AND size_pending = 0 AND git_pending = 0`,
      )
        .bind(Date.now(), id)
        .run();
      if (res.meta.changes) return 'done';
      const row = await getInstance(env, id);
      return row?.status === 'running' && row.pending_op === 'reconfigure' ? 'again' : 'gone';
    });
    if (state === 'done') {
      // A new compute size (D78) shows in the consoles once the provider reports it.
      await recordComputeFacts(ctx, id);
      return { ok: true, outcome: 'applied' };
    }
    if (state === 'gone') return { ok: false, outcome: 'skipped' };
  }
  await releaseReconfigure(ctx, id);
  return { ok: false, outcome: 'skipped' };
}

/** A reconfigure that failed or was aborted gives up its claim; the values stay saved and pending. */
async function releaseReconfigure(ctx: OpsContext, id: string): Promise<void> {
  await ctx.steps.do('release', async () => {
    await ctx.env.DB.prepare(`UPDATE instances SET pending_op = NULL, updated_at = ? WHERE id = ? AND pending_op = 'reconfigure'`)
      .bind(Date.now(), id)
      .run();
    return true;
  });
}

// ---- rotate: renew the instance's credentials (D74) ----

/** How long a running instance's previous heartbeat credential stays accepted after its secrets are renewed. */
export const PREV_CREDENTIAL_GRACE_MS = 30 * 60_000;

/**
 * New tunnel secret, broker secret and heartbeat credential (pending_op = 'rotate', claimed by
 * rotateSecrets in api.ts). The vault key stays (D74). A running instance restarts all three
 * services and the op waits for a beat with the new credential and for the tunnel to reconnect; a
 * suspended or stopped one picks the values up on its next start.
 */
async function rotateOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  // A rotation of every instance starts them spread out (rotateAll).
  if (p.staggerMs) await steps.sleep('stagger', p.staggerMs);
  const { ref, tunnelId } = await steps.do('load', async () => {
    const row = await loadIn(env, id, ROTATABLE, 'rotate');
    const ref = computeRefOf(env, row);
    const tunnelId = parseEdgeRef(row)?.tunnelId;
    if (!ref || !tunnelId) abort('no compute or tunnel');
    return { ref, tunnelId };
  });
  // Every secret is made and applied inside this one step, as in create's `set variables`: a retry
  // makes a fresh set (and a fresh tunnel secret) and applies all of it again, and nothing secret
  // is returned, so nothing reaches the Workflow's stored results or logs.
  const running = await steps.do(
    'renew secrets',
    async () => {
      const row = await loadIn(env, id, ROTATABLE, 'rotate');
      const tunnelToken = await ctx.providers.edge.rotateTunnelSecret(tunnelId);
      const credential = randomToken();
      await ctx.providers.compute.setSecrets(ref, { tunnelToken, brokerSecret: randomToken(), heartbeatCredential: credential });
      // Running: the credential it beats with now stays accepted until its first beat with the new
      // one (heartbeat.ts), for at most PREV_CREDENTIAL_GRACE_MS. A retry of this step within that
      // grace keeps the same previous credential and deadline; an earlier rotation's expired one is
      // never carried over, and no deadline is ever extended, so nothing expired comes back.
      // Not running: nothing beats, so the old one goes at once.
      const isRunning = row.status === 'running';
      const now = Date.now();
      await env.DB.prepare(
        isRunning
          ? `UPDATE instances SET
               heartbeat_cred_hash_prev = CASE WHEN heartbeat_cred_prev_until > ?1 THEN heartbeat_cred_hash_prev ELSE heartbeat_cred_hash END,
               heartbeat_cred_prev_until = CASE WHEN heartbeat_cred_prev_until > ?1 THEN heartbeat_cred_prev_until ELSE ?2 END,
               heartbeat_cred_hash = ?3, updated_at = ?1 WHERE id = ?4`
          : `UPDATE instances SET heartbeat_cred_hash_prev = NULL, heartbeat_cred_prev_until = NULL, heartbeat_cred_hash = ?3, updated_at = ?1 WHERE id = ?4`,
      )
        .bind(now, now + PREV_CREDENTIAL_GRACE_MS, await sha256Hex(credential), id)
        .run();
      return isRunning;
    },
    { sensitive: true },
  );
  if (!running) return finishRotate(ctx, p, false);

  const restarted = await steps.do('restart services', async () => {
    await loadIn(env, id, ['running'], 'rotate');
    const r = await ctx.providers.compute.restartServices(ref);
    await saveRefs(env, id, { compute: r });
    return !(await stopIfStoppedMeanwhile(ctx, id, r));
  });
  if (!restarted) return STOPPED_MEANWHILE;
  // worca's first beat with the new credential retires the old one (heartbeat.ts).
  const beat = await waitForBeat(ctx, id, 'new credential', (row) =>
    !row || row.status !== 'running' || row.pending_op !== 'rotate' ? 'gone' : row.heartbeat_cred_hash_prev === null ? 'done' : 'wait',
  );
  if (beat === 'gone') return { ok: false, outcome: 'gone' };
  // Failed: the old credential stays accepted until its grace ends, then the instance can only beat
  // with the new one, which the provider already holds: any restart (or rotating again) brings it back.
  if (beat === 'timeout') throw new NonRetryableError('rotate: worca did not report in with its new credential in time');
  // cloudflared reconnects with the new token: the old one no longer works, so this is the proof.
  const maxPolls = ctx.maxPolls ?? 60;
  let connected = false;
  for (let i = 0; i < maxPolls && !connected; i++) {
    connected = await steps.do('tunnel: check', async () => {
      const status = (await ctx.providers.edge.tunnelStatuses([tunnelId]))[tunnelId];
      return status === 'healthy' || status === 'degraded';
    });
    if (!connected) await steps.sleep('tunnel: wait', ctx.pollMs ?? 10_000);
  }
  if (!connected) throw new NonRetryableError('rotate: the tunnel did not reconnect with its new token in time');
  return finishRotate(ctx, p, true);
}

async function finishRotate(ctx: OpsContext, p: OpParams, restarted: boolean): Promise<OpResult> {
  const { env } = ctx;
  const id = p.instanceId;
  const done = await ctx.steps.do('finish', async () => {
    const now = Date.now();
    const res = await env.DB.prepare(
      `UPDATE instances SET pending_op = NULL, heartbeat_cred_hash_prev = NULL, heartbeat_cred_prev_until = NULL, secrets_rotated_at = ?, updated_at = ?
         WHERE id = ? AND pending_op = 'rotate'`,
    )
      .bind(now, now, id)
      .run();
    if (!res.meta.changes) return false;
    const row = await getInstance(env, id);
    if (!row) return true;
    await auditOrgSafe(env, row.org_id, {
      actorId: p.actorId ?? null, actorScope: 'platform', action: 'instance.secrets_rotated', targetType: 'instance', targetId: id, details: { restarted },
    });
    // Only a restart is something the org notices; a sleeping instance just starts with the new values.
    if (restarted) {
      const name = await decryptDisplayName(env, row);
      const url = instanceUrl(env, hostFor(env, row.slug));
      await notifyOrgAdmins(
        env,
        row.org_id,
        `Worca ${name} was restarted to renew its credentials`,
        `As a precaution, the platform renewed the credentials ${name} (${url}) uses to connect to ${env.INSTANCE_DOMAIN}, and restarted it for about a minute. ` +
          `Runs that were active paused and resume on their own.\n\nNothing else changed: your data, your settings and the model keys stored on the key page are as they were.`,
      );
    }
    return true;
  });
  return done ? { ok: true, outcome: 'rotated' } : { ok: false, outcome: 'skipped' };
}

/** A rotation that failed or was aborted gives up its claim. The old heartbeat credential stays accepted until its grace ends. */
async function releaseRotate(ctx: OpsContext, id: string): Promise<void> {
  await ctx.steps.do('release', async () => {
    await ctx.env.DB.prepare(`UPDATE instances SET pending_op = NULL, updated_at = ? WHERE id = ? AND pending_op = 'rotate'`)
      .bind(Date.now(), id)
      .run();
    return true;
  });
}

// ---- component refresh: newer service images for the same worca version (D76) ----

/**
 * Polls Cloudflare until every connection of the tunnel reports cloudflared `version`, or the time
 * is up. A provider that can't tell (fake) counts as confirmed.
 */
async function connectorRuns(ctx: OpsContext, tunnelId: string, version: string): Promise<boolean> {
  const maxPolls = ctx.maxPolls ?? 60;
  for (let i = 0; i < maxPolls; i++) {
    const ok = await ctx.steps.do('new connector: check', async () => {
      const versions = await ctx.providers.edge.connectorVersions(tunnelId);
      return versions === null || (versions.length > 0 && versions.every((v) => v === version));
    });
    if (ok) return true;
    await ctx.steps.sleep('new connector: wait', ctx.pollMs ?? 10_000);
  }
  return false;
}

/**
 * Redeploys a running instance's out-of-date services with the images its worca version deploys
 * today (pending_op = 'refresh', claimed by startRefresh in api.ts). Only cloudflared can be out of
 * date this way (REFRESHABLE): worca and the broker keep running, no run is interrupted, and only
 * open connections through the tunnel reconnect. Done once Cloudflare sees only the new connector;
 * not in time: the op fails and the images stay out of date (the provider keeps the previous deployment
 * running when the new one fails).
 */
async function refreshOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  const { ref, tunnelId, version, kinds, before } = await steps.do('load', async () => {
    const row = await loadIn(env, id, ['running'], 'refresh');
    const ref = computeRefOf(env, row);
    const tunnelId = parseEdgeRef(row)?.tunnelId;
    if (!ref || !tunnelId || !isVersion(row.worca_version)) abort('no compute, tunnel or version');
    const kinds = outdatedServices(row, imageSources(env));
    if (kinds.some((k) => !REFRESHABLE.includes(k))) abort(`out of date beyond a refresh: ${kinds.join(', ')}`);
    return { ref, tunnelId, version: row.worca_version, kinds, before: parseDeployedImages(row.deployed_images) };
  });
  const images = imagesFor(version, imageSources(env));
  if (kinds.length) {
    const deployed = await steps.do('deploy components', async () => {
      await loadIn(env, id, ['running'], 'refresh');
      const r = await ctx.providers.compute.deploy(ref, images, kinds);
      await saveRefs(env, id, { compute: r });
      return !(await stopIfStoppedMeanwhile(ctx, id, r));
    });
    if (!deployed) return STOPPED_MEANWHILE;
    if (kinds.includes('cloudflared') && !(await connectorRuns(ctx, tunnelId, imageTag(images.cloudflared)))) {
      throw new NonRetryableError(`refresh: the tunnel did not report cloudflared ${imageTag(images.cloudflared)} in time`);
    }
  }
  const done = await steps.do('finish', async () => {
    const res = await env.DB.prepare(`UPDATE instances SET deployed_images = ?, pending_op = NULL, updated_at = ? WHERE id = ? AND pending_op = 'refresh'`)
      .bind(JSON.stringify(images), Date.now(), id)
      .run();
    if (!res.meta.changes) return false;
    const row = await getInstance(env, id);
    if (row) {
      // Nothing the org notices beyond a moment's reconnect: audited, no mail.
      const from = Object.fromEntries(kinds.map((k) => [k, before?.[k] ?? null]));
      const to = Object.fromEntries(kinds.map((k) => [k, images[k]]));
      await auditOrgSafe(env, row.org_id, {
        actorId: p.actorId ?? null, actorScope: p.automatic ? 'system' : 'platform', action: 'instance.components_refreshed', targetType: 'instance', targetId: id,
        details: { from, to, ...(p.automatic ? { automatic: true } : {}) },
      });
    }
    return true;
  });
  return done ? { ok: true, outcome: 'refreshed' } : { ok: false, outcome: 'skipped' };
}

/** A refresh that failed or was aborted gives up its claim; the images stay recorded as they were. */
async function releaseRefresh(ctx: OpsContext, id: string): Promise<void> {
  await ctx.steps.do('release', async () => {
    await ctx.env.DB.prepare(`UPDATE instances SET pending_op = NULL, updated_at = ? WHERE id = ? AND pending_op = 'refresh'`)
      .bind(Date.now(), id)
      .run();
    return true;
  });
}

// ---- stop for abuse (D16, D47) ----

async function stopOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  const ref = await steps.do('load', async () => computeRefOf(env, await loadIn(env, id, ['stopped'])));
  await steps.do('gate stopped', async () => (await gate(env).setStatus(id, 'stopped'), true));
  if (ref) await steps.do('stop services', async () => (await ctx.providers.compute.stop(ref), true));
  return { ok: true, outcome: 'stopped' };
}

// ---- delete (D29, instance-lifecycle.md "Delete" 1–4) ----

async function deleteOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const { env, steps } = ctx;
  const id = p.instanceId;
  const row = await steps.do('load', async () => {
    const r = await getInstance(env, id);
    if (r && r.status !== 'deleting') abort(`status ${r.status}`);
    return r;
  });
  if (!row) return { ok: true, outcome: 'already_gone' };
  const host = hostFor(env, row.slug);
  const keyHost = hostFor(env, row.key_slug);
  await steps.do('gate deleting', async () => {
    await gate(env).setStatus(id, 'deleting');
    await gate(env).deleteHost(host);
    await gate(env).deleteHost(keyHost);
    return true;
  });
  // The refs are read again in each provider step, not taken from `load`: a create step that
  // was still running when the delete was confirmed may have saved them since (its `overtaken`
  // check, in createOp, covers anything saved after these reads).
  // A create that failed for good half-way through a provider step never saved what that step
  // made: without a saved ref, the project is looked up by its name; the tunnel and the DNS
  // records are always looked up too (by name, and by host with this instance's comment), so
  // nothing a half-finished create left behind survives the delete.
  await steps.do('destroy compute', async () => {
    const compute = computeRefOf(env, (await getInstance(env, id)) ?? row) ?? (await ctx.providers.compute.findProject(id));
    if (compute) await ctx.providers.compute.destroy(compute);
    return true;
  });
  await steps.do('delete edge', async () => {
    const saved = parseEdgeRef((await getInstance(env, id)) ?? row);
    const found = await ctx.providers.edge.findEdge(id, [host, keyHost]);
    const dns = [...new Set([...(saved?.dnsRecordIds ?? []), ...(found?.dnsRecordIds ?? [])])];
    const tunnels = [...new Set([saved?.tunnelId, found?.tunnelId].filter((t): t is string => !!t))];
    if (dns.length) await ctx.providers.edge.deleteDns(dns);
    for (const t of tunnels) await ctx.providers.edge.deleteTunnel(t);
    return true;
  });
  await steps.do('revoke heartbeat credential', async () => {
    await env.DB.prepare(`UPDATE instances SET heartbeat_cred_hash = NULL, heartbeat_cred_hash_prev = NULL, heartbeat_cred_prev_until = NULL, updated_at = ? WHERE id = ?`).bind(Date.now(), id).run();
    return true;
  });
  await steps.do('destroy gate object', async () => (await gate(env).destroy(id), true));
  await steps.do('delete rows', async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM instance_teams WHERE instance_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM heartbeats WHERE instance_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM instances WHERE id = ?`).bind(id),
    ]);
    // Owned by tenancy (0004_policies.sql); absent in some test setups.
    await env.DB.prepare(`DELETE FROM instance_login_policies WHERE instance_id = ?`).bind(id).run().catch(() => undefined);
    await auditPlatformSafe(env, {
      actorId: p.actorId ?? null, actorRole: null, action: 'instance.deleted', targetType: 'instance', targetId: id,
      details: { orgId: row.org_id },
    });
    return true;
  });
  return { ok: true, outcome: 'deleted' };
}

// ---- dispatch ----

/** Wraps a StepRunner so every step writes its phase, attempts and errors to instance_ops. */
export function trackedSteps(env: Env, opId: string, kind: InstanceOp, inner: StepRunner): StepRunner {
  return {
    do<T>(name: string, fn: () => Promise<T>, opts?: { sensitive?: boolean }): Promise<T> {
      return inner.do(
        name,
        async () => {
          await enterStep(env, opId, kind, name);
          try {
            const result = await fn();
            await leaveStep(env, opId);
            return result;
          } catch (err) {
            await leaveStep(env, opId, err);
            throw err;
          }
        },
        opts,
      );
    },
    sleep: (name, ms) => inner.sleep(name, ms),
  };
}

export async function runOp(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  if (!ctx.opId) return dispatch(ctx, p);
  const opId = ctx.opId;
  let result: OpResult;
  try {
    result = await dispatch({ ...ctx, steps: trackedSteps(ctx.env, opId, p.op, ctx.steps) }, p);
  } catch (err) {
    await finishOp(ctx.env, opId, p.op, { error: err });
    throw err;
  }
  await finishOp(ctx.env, opId, p.op, result);
  return result;
}

async function dispatch(ctx: OpsContext, p: OpParams): Promise<OpResult> {
  const c = ctx;
  try {
    switch (p.op) {
      case 'create':
        try {
          return await createOp(c, p);
        } catch (err) {
          if (!isAborted(err)) await recordCreateFailure(c, p.instanceId, err);
          throw err;
        }
      case 'suspend':
        return await suspendOp(c, p);
      case 'wake':
        return await startAndWait(c, p, 'suspended', 'wake');
      case 'lift':
        return await startAndWait(c, p, 'stopped', 'lift');
      case 'upgrade':
        return await upgradeOp(c, p);
      case 'stop':
        return await stopOp(c, p);
      case 'delete':
        return await deleteOp(c, p);
      case 'reconfigure':
        try {
          return await reconfigureOp(c, p);
        } catch (err) {
          await releaseReconfigure(c, p.instanceId);
          throw err;
        }
      case 'rotate':
        try {
          return await rotateOp(c, p);
        } catch (err) {
          await releaseRotate(c, p.instanceId);
          throw err;
        }
      case 'refresh':
        try {
          const r = await refreshOp(c, p);
          if (!r.ok) await releaseRefresh(c, p.instanceId);
          return r;
        } catch (err) {
          await releaseRefresh(c, p.instanceId);
          throw err;
        }
    }
  } catch (err) {
    if (isAborted(err)) return { ok: false, outcome: 'aborted' };
    throw err;
  }
}

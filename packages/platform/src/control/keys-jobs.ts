// Org data-key rotation, the re-encryption half (D38, security.md "Keys").
//
// rotateOrgKey (keys.ts) adds version N of the org's key and calls startOrgReencryption, which
// records a key_rotation_jobs row and starts a KeyRotationWorkflow (keys-workflow.ts). Each
// workflow step calls runOrgJobStep, which does a bounded amount of work:
//
//   running    walk ORG_COLUMNS in order; per column, rows of the org whose ciphertext isn't on
//              version N, by row id, at most ROWS_PER_STEP rows per step. Each value is decrypted
//              with the version it names and encrypted under N with the same field context
//              (table|column|rowId|owner), then written only if it is unchanged since it was read
//              and the job still targets N. Rows that don't decrypt are counted and left alone.
//   verifying  after VERIFY_GRACE_MS from the rotation (isolates cache the current version for
//              keys.ts CACHE_TTL_MS, so one may still write version N-1 for that long), count what
//              is left on older versions. Stragglers start another pass (at most MAX_PASSES).
//              None left, and no ciphertext in a column this registry doesn't know: the older
//              versions are destroyed (wrapped = NULL) and the job is done. Otherwise the job
//              ends `incomplete` and the older versions are kept, so nothing becomes unreadable.
//
// Every column that holds ciphertexts must be listed below: ORG_COLUMNS (re-encrypted here) or
// OTHER_ENCRYPTED_COLUMNS (user-owned). A ciphertext found anywhere else blocks the destruction
// of old org key versions until the column is registered.

import type { Env } from './env';
import type { FieldContext } from './keys-api';
import { forgetKeyCache, reencryptField } from './keys';

export interface OrgEncryptedColumn {
  table: string;
  column: string;
  /** Column holding the AAD row id. */
  idColumn: string;
  /** Column holding the owning org's id. */
  orgColumn: string;
}

/** Every column encrypted with an org's data key (internal-apis.md "Field contexts"). */
export const ORG_COLUMNS: readonly OrgEncryptedColumn[] = [
  { table: 'organization', column: 'name', idColumn: 'id', orgColumn: 'id' },
  { table: 'team', column: 'name', idColumn: 'id', orgColumn: 'organizationId' },
  { table: 'invitation', column: 'email', idColumn: 'id', orgColumn: 'organizationId' },
  // SSO providers without an org are owned by their user (adapter-wrapper fallbackOwner).
  { table: 'ssoProvider', column: 'domain', idColumn: 'id', orgColumn: 'organizationId' },
  { table: 'ssoProvider', column: 'oidcConfig', idColumn: 'id', orgColumn: 'organizationId' },
  { table: 'ssoProvider', column: 'samlConfig', idColumn: 'id', orgColumn: 'organizationId' },
  { table: 'instances', column: 'display_name', idColumn: 'id', orgColumn: 'org_id' },
  // D73: the outbound network policy's host lists (instances/egress-api.ts).
  { table: 'instances', column: 'egress_hosts', idColumn: 'id', orgColumn: 'org_id' },
  { table: 'org_egress_policies', column: 'hosts', idColumn: 'org_id', orgColumn: 'org_id' },
  // D79: the instance's git configuration, credentials included (instances/git-api.ts).
  { table: 'instances', column: 'git_settings', idColumn: 'id', orgColumn: 'org_id' },
  { table: 'audit_org', column: 'details', idColumn: 'id', orgColumn: 'org_id' },
  { table: 'org_login_policies', column: 'required_domain', idColumn: 'org_id', orgColumn: 'org_id' },
  { table: 'org_domains', column: 'domain', idColumn: 'id', orgColumn: 'org_id' },
  // Owned by the org when org_id is set, else by the user (confirmations.ts payloadOwner).
  { table: 'confirmations', column: 'payload', idColumn: 'id', orgColumn: 'org_id' },
];

/** Encrypted columns owned by users; not touched by an org rotation, known to the safety scan. */
export const OTHER_ENCRYPTED_COLUMNS: readonly { table: string; column: string }[] = [
  { table: 'user', column: 'email' },
  { table: 'user', column: 'name' },
  { table: 'session', column: 'ipAddress' },
  { table: 'session', column: 'userAgent' },
  { table: 'account', column: 'accessToken' },
  { table: 'account', column: 'refreshToken' },
  { table: 'account', column: 'idToken' },
  { table: 'registration_codes', column: 'note' },
  { table: 'support_requests', column: 'reason' },
  // The subscriber's own key ({ type: 'user', id: <subscriber id> }, D70).
  { table: 'newsletter_subscribers', column: 'email' },
  // The request's own key ({ type: 'user', id: <request id> }, ids start with `ar_`, D69).
  { table: 'access_requests', column: 'email' },
  { table: 'access_requests', column: 'use_case' },
  { table: 'access_requests', column: 'company' },
  { table: 'access_requests', column: 'decision_note' },
];

export const ROWS_PER_STEP = 200;
export const VERIFY_GRACE_MS = 3 * 60_000;
export const MAX_PASSES = 3;

// Tables that hold no tenant ciphertexts of the kind ORG_COLUMNS describes.
const SCAN_SKIP = /^(sqlite_|_cf_|d1_migrations$|data_keys$|key_rotation_jobs$)/;
const ANY_CIPHERTEXT = 'e1.*';
const SCAN_PATTERN = 'e1.[0-9]*.*.*';
const atVersion = (v: number) => `e1.${v}.*`;
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export type JobStatus = 'running' | 'verifying' | 'done' | 'incomplete';

interface JobRow {
  org_id: string;
  target_version: number;
  status: JobStatus;
  step: number;
  cursor: string | null;
  done: number;
  total: number;
  failed: number;
  passes: number;
  last_error: string | null;
  started_at: number;
}

export type StepResult =
  | { state: 'progress' | 'done' | 'incomplete'; done: number; total: number }
  | { state: 'wait'; waitMs: number; readyAt: number; done: number; total: number }
  | { state: 'stale' };

/** Workflow instance ids allow [A-Za-z0-9_-], at most 100 characters. */
export function workflowId(orgId: string, version: number, hop = 0): string {
  const safe = orgId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return `keys-org-${safe}-v${version}${hop ? `-c${hop}` : ''}`;
}

/** Ciphertexts of the org not yet on `version`, per registered column. */
async function remaining(env: Env, orgId: string, version: number): Promise<number> {
  const results = await env.DB.batch<{ n: number }>(
    ORG_COLUMNS.map((c) =>
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${q(c.table)} WHERE ${q(c.orgColumn)} = ? AND ${q(c.column)} GLOB ? AND ${q(c.column)} NOT GLOB ?`,
      ).bind(orgId, ANY_CIPHERTEXT, atVersion(version)),
    ),
  );
  return results.reduce((sum, r) => sum + (r.results[0]?.n ?? 0), 0);
}

/**
 * Columns outside the registry that hold something shaped like our ciphertexts, as "table.column".
 * One query per table; only run when a job is about to destroy old key versions.
 */
export async function unregisteredCiphertextColumns(env: Env): Promise<string[]> {
  const known = new Set([...ORG_COLUMNS, ...OTHER_ENCRYPTED_COLUMNS].map((c) => `${c.table}.${c.column}`));
  // D1 refuses the pragma_table_info() table function, so: list tables, then PRAGMA each.
  const names = (
    await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all<{ name: string }>()
  ).results
    .map((r) => r.name)
    .filter((t) => !SCAN_SKIP.test(t));
  if (names.length === 0) return [];
  const infos = await env.DB.batch<{ name: string }>(names.map((t) => env.DB.prepare(`PRAGMA table_info(${q(t)})`)));
  const byTable = new Map<string, string[]>();
  names.forEach((t, i) => {
    const columns = (infos[i]?.results ?? []).map((c) => c.name).filter((c) => !known.has(`${t}.${c}`));
    if (columns.length > 0) byTable.set(t, columns);
  });
  const tables = [...byTable.entries()];
  if (tables.length === 0) return [];
  const results = await env.DB.batch<Record<string, number>>(
    tables.map(([t, columns]) =>
      env.DB.prepare(
        `SELECT ${columns.map((c, i) => `EXISTS (SELECT 1 FROM ${q(t)} WHERE ${q(c)} GLOB ?1) AS x${i}`).join(', ')}`,
      ).bind(SCAN_PATTERN),
    ),
  );
  const found: string[] = [];
  tables.forEach(([t, columns], ti) => {
    const row = results[ti]?.results[0] ?? {};
    columns.forEach((c, i) => {
      if (row[`x${i}`]) found.push(`${t}.${c}`);
    });
  });
  return found;
}

/**
 * Records the job for a fresh rotation to `version` and starts its workflow. A job for an older
 * version is replaced; one for a newer version is left alone.
 */
export async function startOrgReencryption(env: Env, orgId: string, version: number, at = Date.now()): Promise<void> {
  const total = await remaining(env, orgId, version);
  await env.DB.prepare(
    `INSERT INTO key_rotation_jobs (org_id, target_version, status, step, cursor, done, total, failed, passes, last_error, started_at, updated_at, finished_at)
     VALUES (?1, ?2, 'running', 0, NULL, 0, ?3, 0, 1, NULL, ?4, ?4, NULL)
     ON CONFLICT (org_id) DO UPDATE SET target_version = excluded.target_version, status = 'running', step = 0,
       cursor = NULL, done = 0, total = excluded.total, failed = 0, passes = 1, last_error = NULL,
       started_at = excluded.started_at, updated_at = excluded.updated_at, finished_at = NULL
     WHERE excluded.target_version > key_rotation_jobs.target_version`,
  )
    .bind(orgId, version, total, at)
    .run();
  if (env.KEY_ROTATION) {
    await env.KEY_ROTATION.create({ id: workflowId(orgId, version), params: { orgId, version } });
  }
}

async function loadJob(env: Env, orgId: string): Promise<JobRow | null> {
  return env.DB.prepare('SELECT * FROM key_rotation_jobs WHERE org_id = ?').bind(orgId).first<JobRow>();
}

async function finish(env: Env, job: JobRow, status: 'done' | 'incomplete', error: string | null, now: number) {
  await env.DB.prepare(
    `UPDATE key_rotation_jobs SET status = ?, last_error = ?, updated_at = ?, finished_at = ?
      WHERE org_id = ? AND target_version = ?`,
  )
    .bind(status, error, now, now, job.org_id, job.target_version)
    .run();
}

async function targetIsLive(env: Env, orgId: string, version: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM data_keys WHERE owner_type = 'org' AND owner_id = ? AND version = ? AND wrapped IS NOT NULL AND destroyed_at IS NULL`,
  )
    .bind(orgId, version)
    .first<{ ok: number }>();
  return !!row;
}

/** One bounded step of the org's job. Idempotent: a retried step redoes nothing already done. */
export async function runOrgJobStep(
  env: Env,
  orgId: string,
  version: number,
  opts: { now?: number; rows?: number } = {},
): Promise<StepResult> {
  const now = opts.now ?? Date.now();
  const job = await loadJob(env, orgId);
  if (!job || job.target_version !== version) return { state: 'stale' };
  const progress = (j: Pick<JobRow, 'done' | 'total'>) => ({ done: Math.min(j.done, j.total), total: j.total });
  if (job.status === 'done' || job.status === 'incomplete') return { state: job.status, ...progress(job) };

  if (!(await targetIsLive(env, orgId, version))) {
    await finish(env, job, 'incomplete', 'the org key was destroyed', now);
    return { state: 'incomplete', ...progress(job) };
  }

  if (job.status === 'running') {
    let budget = Math.max(opts.rows ?? ROWS_PER_STEP, 1);
    let { step, cursor, done, failed } = job;
    while (budget > 0 && step < ORG_COLUMNS.length) {
      const col = ORG_COLUMNS[step]!;
      const rows = await env.DB.prepare(
        `SELECT ${q(col.idColumn)} AS id, ${q(col.column)} AS v FROM ${q(col.table)}
          WHERE ${q(col.orgColumn)} = ? AND ${q(col.column)} GLOB ? AND ${q(col.column)} NOT GLOB ? AND ${q(col.idColumn)} > ?
          ORDER BY ${q(col.idColumn)} LIMIT ?`,
      )
        .bind(orgId, ANY_CIPHERTEXT, atVersion(version), cursor ?? '', budget)
        .all<{ id: string; v: string }>();
      const updates: D1PreparedStatement[] = [];
      for (const r of rows.results) {
        const ctx: FieldContext = { table: col.table, column: col.column, rowId: String(r.id), owner: { type: 'org', id: orgId } };
        try {
          const next = await reencryptField(env, ctx, r.v, version);
          updates.push(
            env.DB.prepare(
              `UPDATE ${q(col.table)} SET ${q(col.column)} = ?
                WHERE ${q(col.idColumn)} = ? AND ${q(col.orgColumn)} = ? AND ${q(col.column)} = ?
                  AND EXISTS (SELECT 1 FROM key_rotation_jobs WHERE org_id = ? AND target_version = ? AND status = 'running')`,
            ).bind(next, r.id, orgId, r.v, orgId, version),
          );
        } catch (err) {
          failed++;
          console.error(JSON.stringify({ at: 'keys.reencrypt', orgId, table: col.table, column: col.column, rowId: r.id, error: (err as Error).name }));
        }
      }
      if (updates.length > 0) await env.DB.batch(updates);
      done += rows.results.length;
      budget -= rows.results.length;
      if (budget > 0) {
        // Fewer rows than asked for: this column is finished.
        step++;
        cursor = null;
      } else {
        cursor = String(rows.results.at(-1)!.id);
      }
    }
    const status: JobStatus = step >= ORG_COLUMNS.length ? 'verifying' : 'running';
    await env.DB.prepare(
      `UPDATE key_rotation_jobs SET status = ?, step = ?, cursor = ?, done = ?, failed = ?, updated_at = ?
        WHERE org_id = ? AND target_version = ? AND status = 'running'`,
    )
      .bind(status, step, cursor, done, failed, now, orgId, version)
      .run();
    return { state: 'progress', ...progress({ done, total: job.total }) };
  }

  // verifying
  const waitMs = job.started_at + VERIFY_GRACE_MS - now;
  if (waitMs > 0) return { state: 'wait', waitMs, readyAt: job.started_at + VERIFY_GRACE_MS, ...progress(job) };
  const left = await remaining(env, orgId, version);
  if (left > 0) {
    if (left > job.failed && job.passes < MAX_PASSES) {
      // Written under an older version after the pass went by: go round again.
      const total = Math.max(job.total, job.done + left);
      await env.DB.prepare(
        `UPDATE key_rotation_jobs SET status = 'running', step = 0, cursor = NULL, failed = 0, passes = passes + 1,
           total = ?, updated_at = ? WHERE org_id = ? AND target_version = ? AND status = 'verifying'`,
      )
        .bind(total, now, orgId, version)
        .run();
      return { state: 'progress', ...progress({ done: job.done, total }) };
    }
    const error = `${left} ciphertexts still use older key versions (${job.failed} could not be decrypted); older versions kept`;
    await finish(env, job, 'incomplete', error, now);
    return { state: 'incomplete', ...progress(job) };
  }
  const unknown = await unregisteredCiphertextColumns(env);
  if (unknown.length > 0) {
    const error = `ciphertexts in columns the rotation doesn't know: ${unknown.join(', ')}; older versions kept`;
    await finish(env, job, 'incomplete', error, now);
    return { state: 'incomplete', ...progress(job) };
  }
  // Nothing references the older versions any more: destroy them, only if the job is unchanged.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE data_keys SET wrapped = NULL, destroyed_at = ?1
        WHERE owner_type = 'org' AND owner_id = ?2 AND version < ?3 AND destroyed_at IS NULL
          AND EXISTS (SELECT 1 FROM key_rotation_jobs WHERE org_id = ?2 AND target_version = ?3 AND status = 'verifying')`,
    ).bind(now, orgId, version),
    env.DB.prepare(
      `UPDATE key_rotation_jobs SET status = 'done', done = total, updated_at = ?1, finished_at = ?1
        WHERE org_id = ?2 AND target_version = ?3 AND status = 'verifying'`,
    ).bind(now, orgId, version),
  ]);
  forgetKeyCache({ type: 'org', id: orgId });
  return { state: 'done', done: job.total, total: job.total };
}

export interface OrgKeyInfo {
  /** Version new ciphertexts use; null when the org has no live key. */
  version: number | null;
  /** When and by whom that version was made by a rotation; null for the first version. */
  rotatedAt: number | null;
  rotatedBy: string | null;
  reencryption: { status: JobStatus | 'none'; done: number; total: number; failed: number; error: string | null };
}

/** For the org settings page (D38). */
export async function getOrgKeyInfo(env: Env, orgId: string): Promise<OrgKeyInfo> {
  const key = await env.DB.prepare(
    `SELECT version, rotated_at, rotated_by FROM data_keys
      WHERE owner_type = 'org' AND owner_id = ? AND wrapped IS NOT NULL AND destroyed_at IS NULL
      ORDER BY version DESC LIMIT 1`,
  )
    .bind(orgId)
    .first<{ version: number; rotated_at: number | null; rotated_by: string | null }>();
  const job = await loadJob(env, orgId);
  return {
    version: key?.version ?? null,
    rotatedAt: key?.rotated_at ?? null,
    rotatedBy: key?.rotated_by ?? null,
    reencryption: job
      ? { status: job.status, done: Math.min(job.done, job.total), total: job.total, failed: job.failed, error: job.last_error }
      : { status: 'none', done: 0, total: 0, failed: 0, error: null },
  };
}

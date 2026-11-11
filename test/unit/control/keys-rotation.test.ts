// Org data-key rotation with re-encryption (D38): keys.ts rotateOrgKey + keys-jobs.ts.
import { env as cfEnv, introspectWorkflowInstance } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { getKeyRing, reencryptField } from '../../../packages/platform/src/control/keys';
import type { FieldContext, KeyOwner } from '../../../packages/platform/src/control/keys-api';
import {
  getOrgKeyInfo,
  ORG_COLUMNS,
  runOrgJobStep,
  unregisteredCiphertextColumns,
  VERIFY_GRACE_MS,
  workflowId,
} from '../../../packages/platform/src/control/keys-jobs';
import { keysEnv, uid } from './helpers/keys-env';

// The workflow is driven by hand here: no KEY_ROTATION binding, so rotateOrgKey only records the job.
const env = keysEnv({ KEY_ROTATION: undefined });
const ring = getKeyRing(env);
const DB = env.DB;

const org = (id: string): KeyOwner => ({ type: 'org', id });
const ctx = (table: string, column: string, rowId: string, orgId: string): FieldContext => ({ table, column, rowId, owner: org(orgId) });

interface Seeded {
  orgId: string;
  /** [table, column, idColumn, rowId, plaintext] */
  fields: [string, string, string, string, string][];
}

/** An org with ciphertexts in several registered columns, under its current key version. */
async function seedOrg(teams = 3): Promise<Seeded> {
  const orgId = uid();
  const o = org(orgId);
  await ring.ensureKey(o);
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const fields: Seeded['fields'] = [];
  const enc = async (table: string, column: string, rowId: string, plain: string) => {
    fields.push([table, column, table === 'org_login_policies' ? 'org_id' : 'id', rowId, plain]);
    return ring.encrypt(ctx(table, column, rowId, orgId), plain);
  };
  await DB.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
    .bind(orgId, await enc('organization', 'name', orgId, 'Acme Secret'), orgId.slice(0, 12), iso)
    .run();
  for (let i = 0; i < teams; i++) {
    const id = uid();
    await DB.prepare('INSERT INTO team (id, name, memberCount, organizationId, createdAt) VALUES (?, ?, 0, ?, ?)')
      .bind(id, await enc('team', 'name', id, `Team ${i}`), orgId, iso)
      .run();
  }
  const auditId = uid();
  await DB.prepare("INSERT INTO audit_org (id, org_id, at, actor_scope, action, details) VALUES (?, ?, ?, 'tenant', 'team.created', ?)")
    .bind(auditId, orgId, now, await enc('audit_org', 'details', auditId, '{"name":"Team 0"}'))
    .run();
  await DB.prepare('INSERT INTO org_login_policies (org_id, allowed_methods, required_domain, updated_at) VALUES (?, ?, ?, ?)')
    .bind(orgId, '[]', await enc('org_login_policies', 'required_domain', orgId, 'acme.example'), now)
    .run();
  const confId = uid();
  await DB.prepare(
    "INSERT INTO confirmations (id, user_id, org_id, action, target, payload, token_hash, expires_at, created_at) VALUES (?, ?, ?, 'x', 't', ?, ?, ?, ?)",
  )
    .bind(confId, uid(), orgId, await enc('confirmations', 'payload', confId, '{"summary":"s"}'), uid(), now + 60_000, now)
    .run();
  return { orgId, fields };
}

async function stored(table: string, column: string, idColumn: string, rowId: string): Promise<string> {
  const r = await DB.prepare(`SELECT "${column}" AS v FROM "${table}" WHERE "${idColumn}" = ?`).bind(rowId).first<{ v: string }>();
  return r!.v;
}

async function readAll(s: Seeded): Promise<string[]> {
  const out: string[] = [];
  for (const [t, c, idc, id] of s.fields) out.push(await ring.decrypt(ctx(t, c, id, s.orgId), await stored(t, c, idc, id)));
  return out;
}

async function versions(s: Seeded): Promise<string[]> {
  const out: string[] = [];
  for (const [t, c, idc, id] of s.fields) out.push((await stored(t, c, idc, id)).split('.')[1]!);
  return out;
}

async function keyRows(orgId: string) {
  return (
    await DB.prepare('SELECT version, wrapped, destroyed_at, rotated_at, rotated_by FROM data_keys WHERE owner_type = ? AND owner_id = ? ORDER BY version')
      .bind('org', orgId)
      .all<{ version: number; wrapped: string | null; destroyed_at: number | null; rotated_at: number | null; rotated_by: string | null }>()
  ).results;
}

/** Runs steps (`rows` each) until the job leaves `running`; returns the job's started_at. */
async function runPasses(orgId: string, version: number, rows = 2): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const job = await DB.prepare('SELECT status, started_at FROM key_rotation_jobs WHERE org_id = ?').bind(orgId).first<{ status: string; started_at: number }>();
    if (job!.status !== 'running') return job!.started_at;
    expect((await runOrgJobStep(env, orgId, version, { rows })).state).toBe('progress');
  }
  throw new Error('job did not finish its pass');
}

describe('org key rotation with re-encryption (D38)', () => {
  it('re-encrypts every org ciphertext, stays readable throughout, then destroys the old version', async () => {
    const s = await seedOrg();
    const other = await seedOrg(1);
    const plain = s.fields.map((f) => f[4]);
    const by = uid();
    expect(await versions(s)).toEqual(s.fields.map(() => '1'));

    expect(await ring.rotateOrgKey(s.orgId, { by })).toBe(2);
    let info = await getOrgKeyInfo(env, s.orgId);
    expect(info.version).toBe(2);
    expect(info.rotatedBy).toBe(by);
    expect(info.rotatedAt).toBeGreaterThan(0);
    expect(info.reencryption).toMatchObject({ status: 'running', done: 0, total: s.fields.length });

    // A bounded step leaves versions mixed; everything still decrypts.
    expect(await runOrgJobStep(env, s.orgId, 2, { rows: 2 })).toMatchObject({ state: 'progress', done: 2 });
    const mixed = await versions(s);
    expect(mixed.filter((v) => v === '2')).toHaveLength(2);
    expect(mixed.filter((v) => v === '1')).toHaveLength(s.fields.length - 2);
    expect(await readAll(s)).toEqual(plain);
    expect((await getOrgKeyInfo(env, s.orgId)).reencryption).toMatchObject({ status: 'running', done: 2 });

    // New writes during the job use the new version.
    const fresh = await ring.encrypt(ctx('team', 'name', uid(), s.orgId), 'New team');
    expect(fresh).toMatch(/^e1\.2\./);

    const startedAt = await runPasses(s.orgId, 2);
    expect(await versions(s)).toEqual(s.fields.map(() => '2'));
    expect(await readAll(s)).toEqual(plain);

    // Verification waits out the per-isolate version cache before destroying anything.
    const wait = await runOrgJobStep(env, s.orgId, 2, { now: startedAt + 1000 });
    expect(wait.state).toBe('wait');
    expect((await keyRows(s.orgId))[0]!.wrapped).not.toBeNull();

    const done = await runOrgJobStep(env, s.orgId, 2, { now: startedAt + VERIFY_GRACE_MS });
    expect(done).toMatchObject({ state: 'done', done: s.fields.length, total: s.fields.length });
    const rows = await keyRows(s.orgId);
    expect(rows[0]).toMatchObject({ version: 1, wrapped: null });
    expect(rows[0]!.destroyed_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ version: 2, rotated_by: by });
    expect(rows[1]!.wrapped).not.toBeNull();
    expect(await readAll(s)).toEqual(plain);
    info = await getOrgKeyInfo(env, s.orgId);
    expect(info.reencryption).toMatchObject({ status: 'done', done: s.fields.length, total: s.fields.length });

    // The other org was not touched.
    expect(await versions(other)).toEqual(other.fields.map(() => '1'));
    expect(await readAll(other)).toEqual(other.fields.map((f) => f[4]));
  });

  it('goes round again for rows written under the old version after the pass', async () => {
    const s = await seedOrg(1);
    await ring.rotateOrgKey(s.orgId);
    const startedAt = await runPasses(s.orgId, 2, 50);
    // An isolate with a stale cached version writes version 1 after the pass went by.
    const teamId = uid();
    const c = ctx('team', 'name', teamId, s.orgId);
    const old = await reencryptField(env, c, await ring.encrypt(c, 'Late team'), 1);
    expect(old).toMatch(/^e1\.1\./);
    await DB.prepare('INSERT INTO team (id, name, memberCount, organizationId, createdAt) VALUES (?, ?, 0, ?, ?)')
      .bind(teamId, old, s.orgId, new Date().toISOString())
      .run();

    expect((await runOrgJobStep(env, s.orgId, 2, { now: startedAt + VERIFY_GRACE_MS })).state).toBe('progress');
    const job = await DB.prepare('SELECT status, passes FROM key_rotation_jobs WHERE org_id = ?').bind(s.orgId).first();
    expect(job).toMatchObject({ status: 'running', passes: 2 });
    await runPasses(s.orgId, 2, 50);
    expect((await runOrgJobStep(env, s.orgId, 2, { now: startedAt + VERIFY_GRACE_MS })).state).toBe('done');
    expect(await stored('team', 'name', 'id', teamId)).toMatch(/^e1\.2\./);
    expect(await ring.decrypt(c, await stored('team', 'name', 'id', teamId))).toBe('Late team');
  });

  it('keeps the old version when a row cannot be re-encrypted', async () => {
    const s = await seedOrg(1);
    const badId = uid();
    // Right shape, wrong bytes: decrypting fails, so the row can't move to the new version.
    await DB.prepare('INSERT INTO team (id, name, memberCount, organizationId, createdAt) VALUES (?, ?, 0, ?, ?)')
      .bind(badId, 'e1.1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB', s.orgId, new Date().toISOString())
      .run();
    await ring.rotateOrgKey(s.orgId);
    const startedAt = await runPasses(s.orgId, 2, 50);
    expect(await runOrgJobStep(env, s.orgId, 2, { now: startedAt + VERIFY_GRACE_MS })).toMatchObject({ state: 'incomplete' });
    const info = await getOrgKeyInfo(env, s.orgId);
    expect(info.reencryption.status).toBe('incomplete');
    expect(info.reencryption.failed).toBe(1);
    expect(info.reencryption.error).toMatch(/older versions kept/);
    expect((await keyRows(s.orgId))[0]!.wrapped).not.toBeNull();
    expect(await readAll(s)).toEqual(s.fields.map((f) => f[4]));
  });

  it('keeps the old version while an unregistered column holds ciphertexts', async () => {
    const s = await seedOrg(1);
    await DB.prepare('CREATE TABLE tmp_unregistered (id TEXT PRIMARY KEY, secret TEXT)').run();
    try {
      await DB.prepare('INSERT INTO tmp_unregistered VALUES (?, ?)')
        .bind('x', await ring.encrypt(ctx('tmp_unregistered', 'secret', 'x', s.orgId), 'hidden'))
        .run();
      expect(await unregisteredCiphertextColumns(env)).toEqual(['tmp_unregistered.secret']);
      await ring.rotateOrgKey(s.orgId);
      const startedAt = await runPasses(s.orgId, 2, 50);
      expect((await runOrgJobStep(env, s.orgId, 2, { now: startedAt + VERIFY_GRACE_MS })).state).toBe('incomplete');
      expect((await getOrgKeyInfo(env, s.orgId)).reencryption.error).toMatch(/tmp_unregistered\.secret/);
      expect((await keyRows(s.orgId))[0]!.wrapped).not.toBeNull();
    } finally {
      await DB.prepare('DROP TABLE tmp_unregistered').run();
    }
    expect(await unregisteredCiphertextColumns(env)).toEqual([]);
  });

  it('a newer rotation supersedes a running job; the old job stops and its writes are refused', async () => {
    const s = await seedOrg(2);
    await ring.rotateOrgKey(s.orgId);
    expect(await ring.rotateOrgKey(s.orgId)).toBe(3);
    expect(await runOrgJobStep(env, s.orgId, 2)).toEqual({ state: 'stale' });
    const startedAt = await runPasses(s.orgId, 3, 50);
    expect(await versions(s)).toEqual(s.fields.map(() => '3'));
    expect((await runOrgJobStep(env, s.orgId, 3, { now: startedAt + VERIFY_GRACE_MS })).state).toBe('done');
    const rows = await keyRows(s.orgId);
    expect(rows.map((r) => r.wrapped === null)).toEqual([true, true, false]);
    expect(await readAll(s)).toEqual(s.fields.map((f) => f[4]));
  });

  it('stops when the org key is destroyed mid-job', async () => {
    const s = await seedOrg(1);
    await ring.rotateOrgKey(s.orgId);
    await ring.destroyKey(org(s.orgId));
    expect((await runOrgJobStep(env, s.orgId, 2)).state).toBe('incomplete');
    expect((await getOrgKeyInfo(env, s.orgId)).version).toBeNull();
  });

  it('audit_org stays append-only except for re-encrypting details', async () => {
    const s = await seedOrg(0);
    const row = await DB.prepare('SELECT id, details FROM audit_org WHERE org_id = ?').bind(s.orgId).first<{ id: string; details: string }>();
    await expect(DB.prepare("UPDATE audit_org SET action = 'y' WHERE id = ?").bind(row!.id).run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare("UPDATE audit_org SET details = 'plain' WHERE id = ?").bind(row!.id).run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare("UPDATE audit_org SET details = ?, actor_id = 'z' WHERE id = ?").bind(row!.details, row!.id).run()).rejects.toThrow(
      /append-only/,
    );
    // NULL details, or a ciphertext swap at the same version (replay/substitution), are refused.
    await expect(DB.prepare('UPDATE audit_org SET details = NULL WHERE id = ?').bind(row!.id).run()).rejects.toThrow(/append-only/);
    const c = ctx('audit_org', 'details', row!.id, s.orgId);
    const sameVersion = await reencryptField(env, c, row!.details, 1);
    await expect(DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(sameVersion, row!.id).run()).rejects.toThrow(/append-only/);
    // A malformed version part is refused even if it compares greater.
    const [, , iv, ct] = row!.details.split('.');
    await expect(DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(`e1.9x.${iv}.${ct}`, row!.id).run()).rejects.toThrow(/append-only/);

    await ring.rotateOrgKey(s.orgId);
    await ring.rotateOrgKey(s.orgId); // versions 2 and 3
    const v3 = await reencryptField(env, c, row!.details, 3);
    await DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(v3, row!.id).run();
    // Never back to an older version (numeric compare: 10 > 9, not text order).
    const v2 = await reencryptField(env, c, v3, 2);
    await expect(DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(v2, row!.id).run()).rejects.toThrow(/append-only/);
    await expect(DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(row!.details, row!.id).run()).rejects.toThrow(/append-only/);
    const [, , iv3, ct3] = v3.split('.');
    await DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(`e1.10.${iv3}.${ct3}`, row!.id).run();
    await expect(DB.prepare('UPDATE audit_org SET details = ? WHERE id = ?').bind(`e1.9.${iv3}.${ct3}`, row!.id).run()).rejects.toThrow(/append-only/);
  });

  it('getOrgKeyInfo before any rotation, and workflow ids are valid', async () => {
    const s = await seedOrg(0);
    expect(await getOrgKeyInfo(env, s.orgId)).toEqual({
      version: 1,
      rotatedAt: null,
      rotatedBy: null,
      reencryption: { status: 'none', done: 0, total: 0, failed: 0, error: null },
    });
    expect(workflowId('org.with:odd/chars', 4, 2)).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    // Every registered table and column exists.
    for (const c of ORG_COLUMNS) await DB.prepare(`SELECT "${c.column}", "${c.idColumn}", "${c.orgColumn}" FROM "${c.table}" LIMIT 0`).run();
  });
});

// The workflow runs with the Worker's own bindings (MASTER_KEY from .dev.vars), not keysEnv's
// test secrets, so this test seeds with those and needs them configured.
const realEnv = cfEnv as unknown as Env;
const haveRealKeys = !!realEnv.MASTER_KEY && !!realEnv.BLIND_INDEX_KEY;

describe('KeyRotationWorkflow', () => {
  it.runIf(haveRealKeys)('rotateOrgKey starts the workflow, which re-encrypts, verifies and destroys the old version', async () => {
    const wfRing = getKeyRing(realEnv);
    const orgId = uid();
    const teamIds = [uid(), uid(), uid()];
    await wfRing.ensureKey(org(orgId));
    await DB.prepare('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)')
      .bind(orgId, await wfRing.encrypt(ctx('organization', 'name', orgId, orgId), 'Wf Org'), orgId.slice(0, 12), new Date().toISOString())
      .run();
    for (const id of teamIds) {
      await DB.prepare('INSERT INTO team (id, name, memberCount, organizationId, createdAt) VALUES (?, ?, 0, ?, ?)')
        .bind(id, await wfRing.encrypt(ctx('team', 'name', id, orgId), `T ${id}`), orgId, new Date().toISOString())
        .run();
    }
    const instance = await introspectWorkflowInstance(realEnv.KEY_ROTATION!, workflowId(orgId, 2));
    try {
      await instance.modify(async (m) => {
        await m.disableSleeps();
      });
      expect(await wfRing.rotateOrgKey(orgId, { by: 'u1' })).toBe(2);
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toEqual({ state: 'done', done: 4, total: 4 });
    } finally {
      await instance.dispose();
    }
    for (const id of teamIds) {
      const v = await stored('team', 'name', 'id', id);
      expect(v).toMatch(/^e1\.2\./);
      expect(await wfRing.decrypt(ctx('team', 'name', id, orgId), v)).toBe(`T ${id}`);
    }
    expect((await keyRows(orgId)).map((r) => r.wrapped === null)).toEqual([true, false]);
    expect((await getOrgKeyInfo(realEnv, orgId)).reencryption.status).toBe('done');
  });
});

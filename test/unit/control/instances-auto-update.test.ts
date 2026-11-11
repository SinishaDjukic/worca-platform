// Automatic updates (D26 as amended, D75; src/control/instances/auto-update.ts).
import { createExecutionContext, createScheduledController, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { startUpgrade } from '../../../packages/platform/src/control/instances/api';
import { AUTO_QUIET_MS, autoUpdate, isMicroUpdate, isMinorUpdate } from '../../../packages/platform/src/control/instances/auto-update';
import { CRON_STALE, runCrons } from '../../../packages/platform/src/control/instances/crons';
import { runOp } from '../../../packages/platform/src/control/instances/ops';
import { getProviders } from '../../../packages/platform/src/control/providers';
import { beat, E, fakeStubFetch, gateFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const NOW = Date.now();

async function setLatest(version: string): Promise<void> {
  await E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_version', ?, 0)`).bind(version).run();
}

/** A running instance on 1.9.1 with automatic updates on and an idle, fresh heartbeat. */
async function idleInstance(orgId: string, fields: Record<string, string | number | null> = {}, hb: Partial<{ received_at: number; suspendable: number; next_scheduled_at: number | null }> = {}) {
  const i = await seedInstance(orgId, { worca_version: '1.9.1', ...fields });
  const b = { received_at: NOW - 60_000, suspendable: 1, next_scheduled_at: null, ...hb };
  await E.DB.prepare(
    `INSERT INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, ?, 'ok', ?, '{}', ?, ?)`,
  )
    .bind(i.id, b.received_at, fields.worca_version ?? '1.9.1', b.next_scheduled_at, b.suspendable)
    .run();
  return i;
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
  // Earlier tests' instances never take part: the cron looks at every instance.
  await E.DB.prepare(`UPDATE instances SET auto_update = 'off'`).run();
  await setLatest('1.9.2');
});

afterEach(async () => {
  await E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'worca_version'`).run();
});

describe('isMicroUpdate', () => {
  it('accepts only a higher micro of the same major.minor', () => {
    expect(isMicroUpdate('1.9.1', '1.9.2')).toBe(true);
    expect(isMicroUpdate('1.9.0', '1.9.10')).toBe(true);
    expect(isMicroUpdate('1.9.2', '1.9.2')).toBe(false);
    expect(isMicroUpdate('1.9.3', '1.9.2')).toBe(false);
    expect(isMicroUpdate('1.9.9', '1.10.0')).toBe(false);
    expect(isMicroUpdate('1.9.1', '2.9.2')).toBe(false);
    expect(isMicroUpdate('1.9.1', '1.9.2-rc.1')).toBe(false);
    expect(isMicroUpdate('1.9.1-rc.1', '1.9.2')).toBe(false);
    expect(isMicroUpdate(null, '1.9.2')).toBe(false);
  });
});

describe('isMinorUpdate (D75)', () => {
  it('accepts a higher minor of the same major, with any micro', () => {
    expect(isMinorUpdate('1.9.4', '1.10.0')).toBe(true);
    expect(isMinorUpdate('1.9.4', '1.11.3')).toBe(true);
    expect(isMinorUpdate('1.9.1', '1.9.2')).toBe(false); // a micro
    expect(isMinorUpdate('1.10.0', '1.9.9')).toBe(false);
    expect(isMinorUpdate('1.9.4', '2.0.0')).toBe(false);
    expect(isMinorUpdate('1.9.4', '1.10.0-rc.1')).toBe(false);
    expect(isMinorUpdate(null, '1.10.0')).toBe(false);
  });
});

describe('eligibility', () => {
  it('starts a micro upgrade through the shared start, as the system actor', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId);
    expect(await autoUpdate(E, NOW)).toEqual([i.id]);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'upgrading', target_version: '1.9.2' });
    expect(recorded.ops).toEqual([{ op: 'upgrade', instanceId: i.id, actorId: null, version: '1.9.2', automatic: true }]);
    expect(recorded.auditOrg).toEqual([
      {
        orgId: o.orgId, actorId: null, actorScope: 'system', action: 'instance.upgrade_started', targetType: 'instance', targetId: i.id,
        details: { from: '1.9.1', to: '1.9.2', automatic: true },
      },
    ]);
    expect((await gateFake().calls()).filter((c) => c[0] === 'setStatus')).toEqual([['setStatus', i.id, 'upgrading']]);
  });

  it('with micro, never crosses a minor or major version', async () => {
    const o = await seedOrg();
    await idleInstance(o.orgId, { worca_version: '1.8.5' });
    await idleInstance(o.orgId, { worca_version: '0.9.1' });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    await setLatest('1.10.0');
    await idleInstance(o.orgId, { worca_version: '1.9.9' });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    expect(recorded.ops).toEqual([]);
  });

  it('with minor (D75): takes a newer minor and still every micro, never a major', async () => {
    const o = await seedOrg();
    const micro = await idleInstance(o.orgId, { worca_version: '1.9.4' });
    const minor = await idleInstance(o.orgId, { worca_version: '1.9.4', auto_update_minor: 1 });
    await setLatest('1.10.1');
    expect(await autoUpdate(E, NOW)).toEqual([minor.id]);
    expect(await instanceRow(micro.id)).toMatchObject({ status: 'running', target_version: null });
    expect(recorded.auditOrg.at(-1)).toMatchObject({ action: 'instance.upgrade_started', targetId: minor.id, details: { from: '1.9.4', to: '1.10.1', automatic: true } });
    // A micro of its own minor, as with 'micro'.
    const j = await idleInstance(o.orgId, { worca_version: '1.10.0', auto_update_minor: 1 });
    expect(await autoUpdate(E, NOW)).toEqual([j.id]);
    // A new major: never automatically.
    await setLatest('2.0.0');
    await idleInstance(o.orgId, { worca_version: '1.10.1', auto_update_minor: 1 });
    expect(await autoUpdate(E, NOW)).toEqual([]);
  });

  it('a minor jump never starts once the setting no longer covers it (checked in the same write)', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId, { worca_version: '1.9.4', auto_update: 'micro' });
    expect(await startUpgrade(E, { id: i.id, org_id: o.orgId, worca_version: '1.9.4' }, '1.10.0', { actorId: null, actorScope: 'system', automatic: true })).toBe(false);
    await E.DB.prepare(`UPDATE instances SET auto_update_minor = 1 WHERE id = ?`).bind(i.id).run();
    expect(await startUpgrade(E, { id: i.id, org_id: o.orgId, worca_version: '1.9.4' }, '1.10.0', { actorId: null, actorScope: 'system', automatic: true })).toBe(true);
    // Never a major, whatever the setting.
    const j = await idleInstance(o.orgId, { worca_version: '1.9.4', auto_update_minor: 1 });
    expect(await startUpgrade(E, { id: j.id, org_id: o.orgId, worca_version: '1.9.4' }, '2.0.0', { actorId: null, actorScope: 'system', automatic: true })).toBe(false);
  });

  it('never installs a prerelease', async () => {
    const o = await seedOrg();
    await idleInstance(o.orgId, { worca_version: '1.9.0' });
    // Not a hosted version: latestWorcaVersion falls back to the default (1.9.0), already running.
    await setLatest('1.9.2-rc.1');
    expect(await autoUpdate(E, NOW)).toEqual([]);
  });

  it('skips the version an automatic attempt rolled back from, until a newer micro is published', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId, { auto_update_failed_version: '1.9.2' });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    await setLatest('1.9.3');
    expect(await autoUpdate(E, NOW)).toEqual([i.id]);
    expect((await instanceRow(i.id))?.target_version).toBe('1.9.3');
  });

  it('skips instances with automatic updates off, not running, with an op pending, or stopped for abuse', async () => {
    const o = await seedOrg();
    await idleInstance(o.orgId, { auto_update: 'off' });
    await idleInstance(o.orgId, { status: 'suspended' });
    await idleInstance(o.orgId, { status: 'upgrading', target_version: '1.9.2' });
    await idleInstance(o.orgId, { pending_op: 'suspend' });
    await idleInstance(o.orgId, { status: 'stopped', stopped_reason: 'spam', stopped_by: 'staff' });
    await idleInstance(o.orgId, { stopped_reason: 'spam' }); // a stale reason still blocks it
    expect(await autoUpdate(E, NOW)).toEqual([]);
    expect(recorded.ops).toEqual([]);
  });

  it('starts at most 2 per tick; the next tick takes the rest', async () => {
    const o = await seedOrg();
    const ids = [await idleInstance(o.orgId), await idleInstance(o.orgId), await idleInstance(o.orgId)].map((i) => i.id);
    const first = await autoUpdate(E, NOW);
    expect(first).toHaveLength(2);
    const second = await autoUpdate(E, NOW);
    expect(second).toHaveLength(1);
    expect([...first, ...second].sort()).toEqual([...ids].sort());
  });
});

describe('idle', () => {
  it('needs a fresh heartbeat that says suspendable', async () => {
    const o = await seedOrg();
    await idleInstance(o.orgId, {}, { suspendable: 0 });
    await idleInstance(o.orgId, {}, { received_at: NOW - 11 * 60_000 });
    await seedInstance(o.orgId, { worca_version: '1.9.1' }); // no heartbeat at all
    expect(await autoUpdate(E, NOW)).toEqual([]);
  });

  it('waits until nobody visited for 30 minutes', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId);
    await gateFake().setState(i.id, { lastVisit: NOW - 5 * 60_000 });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    await gateFake().setState(i.id, { lastVisit: NOW - AUTO_QUIET_MS - 1 });
    expect(await autoUpdate(E, NOW)).toEqual([i.id]);
  });

  it('skips an instance with a run scheduled in the next 30 minutes (or overdue)', async () => {
    const o = await seedOrg();
    await idleInstance(o.orgId, {}, { next_scheduled_at: Math.floor((NOW + 20 * 60_000) / 1000) });
    await idleInstance(o.orgId, {}, { next_scheduled_at: Math.floor((NOW - 60_000) / 1000) });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    const later = await idleInstance(o.orgId, {}, { next_scheduled_at: Math.floor((NOW + 2 * 3_600_000) / 1000) });
    expect(await autoUpdate(E, NOW)).toEqual([later.id]);
  });

  it('skips the round when the gate state cannot be read', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId);
    await gateFake().setState(i.id, { unreadable: true });
    expect(await autoUpdate(E, NOW)).toEqual([]);
    expect((await instanceRow(i.id))?.status).toBe('running');
  });

  it('runs on the 5-minute cron', async () => {
    const o = await seedOrg();
    const i = await idleInstance(o.orgId);
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime: NOW }), E, createExecutionContext());
    expect((await instanceRow(i.id))?.status).toBe('upgrading');
  });
});

describe('outcome', () => {
  const sendBeat = (credential: string, version: string) =>
    app.call('POST', '/api/heartbeat', { body: beat({ version }), headers: { authorization: `Bearer ${credential}` } });
  const ctx = (stub: ReturnType<typeof fakeStubFetch>, onSleep: () => Promise<void>, maxPolls = 3) => ({
    env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(onSleep), pollMs: 1, maxPolls,
  });

  it('mails the tenant admins once that the instance was updated while idle', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.1', target_version: '1.9.2' });
    const stub = fakeStubFetch();
    const r = await runOp(ctx(stub, async () => void (await sendBeat(i.credential, '1.9.2'))), {
      op: 'upgrade', instanceId: i.id, actorId: null, version: '1.9.2', automatic: true,
    });
    expect(r).toEqual({ ok: true, outcome: 'upgraded' });
    expect(recorded.mails).toHaveLength(1); // the org's one tenant admin
    const mail = recorded.mails[0]!;
    expect(mail.to).toBe(`${o.admin}@example.com`);
    expect(mail.subject).toBe('Worca Main was updated to 1.9.2');
    expect(mail.text).toContain('from 1.9.1 to 1.9.2');
    expect(mail.text).toContain('idle');
    expect(mail.text).toContain(`${E.APP_ORIGIN}/o/${o.orgId}/instances/${i.id}`);
    expect(mail.text).toContain('Automatic updates');
    expect(recorded.auditOrg.find((a) => a.action === 'instance.upgraded')?.details).toEqual({ from: '1.9.1', to: '1.9.2', automatic: true });
    expect((await instanceRow(i.id))?.auto_update_failed_version).toBeNull();
  });

  it('records the failed version and sends one rollback mail with the automatic context', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.1', target_version: '1.9.2' });
    const stub = fakeStubFetch();
    const r = await runOp(ctx(stub, async () => void (await sendBeat(i.credential, '1.9.1')), 2), {
      op: 'upgrade', instanceId: i.id, actorId: null, version: '1.9.2', automatic: true,
    });
    expect(r).toEqual({ ok: false, outcome: 'rolled_back' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', worca_version: '1.9.1', auto_update_failed_version: '1.9.2' });
    expect(recorded.mails).toHaveLength(1);
    expect(recorded.mails[0]!.subject).toBe('The automatic update of Worca Main to 1.9.2 was rolled back');
    expect(recorded.mails[0]!.text).toContain("1.9.2 won't be installed automatically again");
    expect(recorded.auditOrg.find((a) => a.action === 'instance.upgrade_rolled_back')?.details).toEqual({
      from: '1.9.1', to: '1.9.2', rolledBack: true, automatic: true,
    });
    // The next tick leaves it alone.
    await E.DB.prepare(`INSERT OR REPLACE INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, ?, 'ok', '1.9.1', '{}', NULL, 1)`)
      .bind(i.id, NOW)
      .run();
    expect(await autoUpdate(E, NOW)).toEqual([]);
  });

  it('a minor release says so; its rollback mail asks to check the instance (D75)', async () => {
    const o = await seedOrg();
    await setLatest('1.10.0');
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.4', target_version: '1.10.0' });
    await runOp(ctx(fakeStubFetch(), async () => void (await sendBeat(i.credential, '1.10.0'))), { op: 'upgrade', instanceId: i.id, actorId: null, version: '1.10.0', automatic: true });
    expect(recorded.mails[0]!.text).toContain('This minor release was installed automatically');
    recorded.mails.length = 0;
    const j = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.4', target_version: '1.10.0' });
    await runOp(ctx(fakeStubFetch(), async () => void (await sendBeat(j.credential, '1.9.4')), 2), { op: 'upgrade', instanceId: j.id, actorId: null, version: '1.10.0', automatic: true });
    expect(recorded.mails[0]!.text).toContain('A minor release can change how Worca stores its data: check that Main works as before.');
  });

  it('a micro rollback mail has no data warning', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.1', target_version: '1.9.2' });
    await runOp(ctx(fakeStubFetch(), async () => void (await sendBeat(i.credential, '1.9.1')), 2), { op: 'upgrade', instanceId: i.id, actorId: null, version: '1.9.2', automatic: true });
    expect(recorded.mails[0]!.text).not.toContain('stores its data');
    expect(recorded.mails[0]!.text).not.toContain('This minor release');
  });

  it('an admin-started rollback leaves the failed version unset', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'upgrading', worca_version: '1.9.1', target_version: '1.9.2' });
    await runOp(ctx(fakeStubFetch(), async () => void (await sendBeat(i.credential, '1.9.1')), 2), { op: 'upgrade', instanceId: i.id, version: '1.9.2' });
    expect((await instanceRow(i.id))?.auto_update_failed_version).toBeNull();
    expect(recorded.mails[0]!.subject).toMatch(/rolled back to 1\.9\.1/);
  });
});

describe('after a downgrade', () => {
  it('skips the version a tenant admin downgraded away from, and older ones, until a newer micro', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO worca_releases (version, published_at, published_by) VALUES ('1.9.1', 1, NULL), ('1.9.2', 2, NULL)`).run();
    try {
      const i = await idleInstance(o.orgId, { worca_version: '1.9.2' });
      const r = await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: { version: '1.9.1' } });
      expect(r.status).toBe(202);
      expect(await instanceRow(i.id)).toMatchObject({ status: 'upgrading', target_version: '1.9.1', auto_update_failed_version: '1.9.2' });
      expect(recorded.ops[0]).toEqual({ op: 'upgrade', instanceId: i.id, actorId: o.admin, version: '1.9.1' });
      // The downgrade completed: running 1.9.1 again, idle.
      await E.DB.prepare(`UPDATE instances SET status = 'running', target_version = NULL, worca_version = '1.9.1' WHERE id = ?`).bind(i.id).run();
      expect(await autoUpdate(E, NOW)).toEqual([]); // latest is 1.9.2: skipped
      await setLatest('1.9.3');
      expect(await autoUpdate(E, NOW)).toEqual([i.id]);
      expect((await instanceRow(i.id))?.target_version).toBe('1.9.3');
    } finally {
      await E.DB.prepare(`DELETE FROM worca_releases WHERE version IN ('1.9.1', '1.9.2')`).run();
    }
  });

  it('keeps a higher skipped version and leaves upgrades alone', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR REPLACE INTO worca_releases (version, published_at, published_by) VALUES ('1.9.1', 1, NULL)`).run();
    try {
      const i = await idleInstance(o.orgId, { worca_version: '1.9.2', auto_update_failed_version: '1.9.3' });
      await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: { version: '1.9.1' } });
      expect((await instanceRow(i.id))?.auto_update_failed_version).toBe('1.9.3');
      const j = await idleInstance(o.orgId, { worca_version: '1.9.1' });
      await app.call('POST', `/api/orgs/${o.orgId}/instances/${j.id}/upgrade`, { user: o.admin, body: { version: '1.9.2' } });
      expect(await instanceRow(j.id)).toMatchObject({ status: 'upgrading', auto_update_failed_version: null });
    } finally {
      await E.DB.prepare(`DELETE FROM worca_releases WHERE version = '1.9.1'`).run();
    }
  });
});

describe('settings route', () => {
  it('lets tenant admins turn automatic updates off and on; audited; members read it', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { auto_update: 'micro' });
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamA).run();
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/auto-update`;
    expect((await app.call('PUT', path, { user: o.user, body: { mode: 'off' } })).status).toBe(403);
    expect(await app.call('PUT', path, { user: o.admin, body: { mode: 'sometimes' } })).toEqual({ status: 400, json: { error: 'invalid_body' } });
    expect(await app.call('PUT', path, { user: o.admin, body: { mode: 'off' } })).toEqual({ status: 200, json: { ok: true, autoUpdate: 'off' } });
    expect((await instanceRow(i.id))?.auto_update).toBe('off');
    expect(recorded.auditOrg).toEqual([
      {
        orgId: o.orgId, actorId: o.admin, actorScope: 'tenant', action: 'instance.auto_update_set', targetType: 'instance', targetId: i.id,
        details: { mode: 'off', from: 'micro' },
      },
    ]);
    // The same mode again changes nothing and isn't audited.
    expect((await app.call('PUT', path, { user: o.admin, body: { mode: 'off' } })).status).toBe(200);
    expect(recorded.auditOrg).toHaveLength(1);
    const seen = await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.user });
    expect(seen.json).toMatchObject({ autoUpdate: 'off', autoUpdateFailedVersion: null });
    expect((await app.call('PUT', path, { user: o.admin, body: { mode: 'micro' } })).json.autoUpdate).toBe('micro');
    // D75: minor releases too, audited like the others.
    expect((await app.call('PUT', path, { user: o.admin, body: { mode: 'minor' } })).json.autoUpdate).toBe('minor');
    expect(recorded.auditOrg.at(-1)).toMatchObject({ action: 'instance.auto_update_set', details: { mode: 'minor', from: 'micro' } });
    expect(await instanceRow(i.id)).toMatchObject({ auto_update: 'micro', auto_update_minor: 1 });
    // Off clears both; micro again leaves minor off.
    expect((await app.call('PUT', path, { user: o.admin, body: { mode: 'off' } })).json.autoUpdate).toBe('off');
    expect(await instanceRow(i.id)).toMatchObject({ auto_update: 'off', auto_update_minor: 0 });
    expect((await app.call('PUT', path, { user: o.admin, body: { mode: 'micro' } })).json.autoUpdate).toBe('micro');
    expect(await instanceRow(i.id)).toMatchObject({ auto_update: 'micro', auto_update_minor: 0 });
    const other = await seedOrg();
    expect((await app.call('PUT', path, { user: other.admin, body: { mode: 'off' } })).status).toBe(404);
  });

  it('new instances start with micro, minor off (D75)', async () => {
    const o = await seedOrg();
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    expect(r.json.autoUpdate).toBe('micro');
    expect(await instanceRow(r.json.id)).toMatchObject({ auto_update: 'micro', auto_update_minor: 0 });
  });
});

describe('migration 0020', () => {
  it('sets existing instances to off; rows inserted later default to micro', async () => {
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith('0020_'))!;
    expect(m).toBeTruthy();
    // The migration's statements against a scratch copy of the table (D1 refuses TEMP tables).
    const scratch = 'instances_m0020';
    await E.DB.prepare(`CREATE TABLE ${scratch} (id TEXT PRIMARY KEY, status TEXT NOT NULL)`).run();
    try {
      await E.DB.prepare(`INSERT INTO ${scratch} (id, status) VALUES ('old', 'running')`).run();
      for (const q of m.queries) await E.DB.prepare(q.replace(/\binstances\b/g, scratch)).run();
      await E.DB.prepare(`INSERT INTO ${scratch} (id, status) VALUES ('new', 'creating')`).run();
      const { results } = await E.DB.prepare(`SELECT id, auto_update, auto_update_failed_version FROM ${scratch} ORDER BY id`).all();
      expect(results).toEqual([
        { id: 'new', auto_update: 'micro', auto_update_failed_version: null },
        { id: 'old', auto_update: 'off', auto_update_failed_version: null },
      ]);
      await expect(E.DB.prepare(`UPDATE ${scratch} SET auto_update = 'major'`).run()).rejects.toThrow();
    } finally {
      await E.DB.prepare(`DROP TABLE ${scratch}`).run();
    }
  });
});

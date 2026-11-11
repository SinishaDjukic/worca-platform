import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findInstanceByHost,
  instanceUrl,
  isValidSlug,
  liftStop,
  randomSlug,
  stopForAbuse,
} from '../../../packages/platform/src/control/instances/api';
import { CRON_DAILY, CRON_STALE, markStale, runCrons } from '../../../packages/platform/src/control/instances/crons';
import { imageSources, imagesFor } from '../../../packages/platform/src/control/instances/images';
import { setInstancesDeps } from '../../../packages/platform/src/control/instances/deps';
import { requestSuspend, requestWake } from '../../../packages/platform/src/control/instances/rpc-handlers';
import { beat, E, gateFake, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const ctx = () => createExecutionContext();

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('slugs and hosts', () => {
  it('generates 10-char look-alike-free slugs (D8)', () => {
    for (let i = 0; i < 200; i++) {
      const s = randomSlug();
      expect(isValidSlug(s)).toBe(true);
      expect(s).not.toMatch(/[01lo]/);
    }
    expect(isValidSlug('www')).toBe(false);
  });

  it('finds instances by either host, with any port and case (D9)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const host = `${i.slug}.${E.INSTANCE_DOMAIN}`;
    expect(await findInstanceByHost(E, `${host.toUpperCase()}:8788`)).toEqual({ id: i.id, orgId: o.orgId, kind: 'worca', status: 'running' });
    expect((await findInstanceByHost(E, `${i.keySlug}.${E.INSTANCE_DOMAIN}`))?.kind).toBe('keypage');
    expect(await findInstanceByHost(E, `${i.slug}.example.com`)).toBeNull();
    expect(await findInstanceByHost(E, `x.${host}`)).toBeNull();
    expect(instanceUrl(E, host)).toBe(`${E.INSTANCE_SCHEME}://${host}${E.INSTANCE_ORIGIN_SUFFIX}`);
  });
});

describe('create and list', () => {
  it('creates an instance and starts the create op; the free tier allows one (D33)', async () => {
    const o = await seedOrg();
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: 'Main', status: 'creating', teamIds: [o.teamA] });
    expect(r.json.url).toBe(instanceUrl(E, r.json.host));
    const { results: grants } = await E.DB.prepare(`SELECT team_id FROM instance_teams WHERE instance_id = ?`).bind(r.json.id).all();
    expect(grants).toEqual([{ team_id: o.teamA }]); // D71: assigned with the row
    expect(recorded.ops).toEqual([{ op: 'create', instanceId: r.json.id, actorId: o.admin }]);
    const row = await instanceRow(r.json.id);
    expect(row).toMatchObject({ display_name: 'enc:Main', cpu: 2, memory_mb: 4096, volume_gb: 10 });

    const again = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Second', teamId: o.teamA } });
    expect(again).toEqual({ status: 403, json: { error: 'tier_limit' } });
  });

  it('uses the org tier from org_settings', async () => {
    const o = await seedOrg();
    await E.DB.prepare(`INSERT OR IGNORE INTO tiers (id, name, instances_per_org, vcpu, memory_mb, volume_gb, members) VALUES ('team3', 'Team', 3, 4, 8192, 20, 50)`).run();
    await E.DB.prepare(`INSERT INTO org_settings (org_id, tier, created_at) VALUES (?, 'team3', ?)`).bind(o.orgId, Date.now()).run();
    for (const name of ['a', 'b', 'c']) {
      expect((await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name, teamId: o.teamA } })).status).toBe(201);
    }
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'd', teamId: o.teamA } })).status).toBe(403);
  });

  it('refuses tenant users, outsiders and foreign teams', async () => {
    const o = await seedOrg();
    const other = await seedOrg();
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.user, body: { name: 'x' } })).status).toBe(403);
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: other.admin, body: { name: 'x', teamId: o.teamA } })).status).toBe(404);
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances`, { body: { name: 'x' } })).status).toBe(401);
  });

  it('needs a team of the same org and assigns every team given (D71)', async () => {
    const o = await seedOrg();
    const other = await seedOrg();
    const create = (body: unknown) => app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body });
    expect(await create({ name: 'x' })).toEqual({ status: 400, json: { error: 'team_required' } });
    expect(await create({ name: 'x', teamIds: [] })).toEqual({ status: 400, json: { error: 'team_required' } });
    expect(await create({ name: 'x', teamId: other.teamA })).toEqual({ status: 404, json: { error: 'team_not_found' } });
    expect(await create({ name: 'x', teamId: o.teamA, teamIds: [other.teamA] })).toEqual({ status: 404, json: { error: 'team_not_found' } });
    expect(await create({ name: 'x', teamId: 'nope' })).toEqual({ status: 404, json: { error: 'team_not_found' } });
    const { results } = await E.DB.prepare(`SELECT id FROM instances WHERE org_id = ?`).bind(o.orgId).all();
    expect(results).toEqual([]); // nothing created, nothing started
    expect(recorded.ops).toEqual([]);

    const r = await create({ name: 'Both', teamId: o.teamA, teamIds: [o.teamB, o.teamA] });
    expect(r.status).toBe(201);
    expect([...r.json.teamIds].sort()).toEqual([o.teamA, o.teamB].sort());
    expect(recorded.auditOrg.find((e) => e.action === 'instance.create_started')?.details).toMatchObject({ teamIds: [o.teamA, o.teamB] });
  });

  it('lists all instances to admins and only granted ones to users (D19)', async () => {
    const o = await seedOrg();
    const granted = await seedInstance(o.orgId);
    const hidden = await seedInstance(o.orgId);
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(granted.id, o.teamA).run();
    await E.DB.prepare(
      `INSERT INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, 1, 'ok', '1.8.0', '{"running":2}', NULL, 0)`,
    ).bind(granted.id).run();

    const admin = await app.call('GET', `/api/orgs/${o.orgId}/instances`, { user: o.admin });
    expect(admin.json.instances.map((i: { id: string }) => i.id).sort()).toEqual([granted.id, hidden.id].sort());
    const user = await app.call('GET', `/api/orgs/${o.orgId}/instances`, { user: o.user });
    expect(user.json.instances).toHaveLength(1);
    expect(user.json.instances[0]).toMatchObject({ id: granted.id, name: 'Main', version: '1.8.0', pipelines: { running: 2 }, suspendable: false });
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances`, { user: o.outsider })).json.instances).toEqual([]);
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${hidden.id}`, { user: o.user })).status).toBe(404);
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${granted.id}`, { user: o.user })).status).toBe(200);
  });

  it('renames', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect((await app.call('PATCH', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin, body: { name: 'Renamed' } })).status).toBe(200);
    expect((await instanceRow(i.id))?.display_name).toBe('enc:Renamed');
  });
});

describe('teams', () => {
  it('unassigning a team drops the gate sessions of users who lose access (D46)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await E.DB.batch([
      E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamA),
      E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamB),
    ]);
    const r = await app.call('PUT', `/api/orgs/${o.orgId}/instances/${i.id}/teams`, { user: o.admin, body: { teamIds: [o.teamB] } });
    expect(r.json).toEqual({ teamIds: [o.teamB], droppedUsers: 1 });
    // `both` keeps access through teamB; only `user` is dropped.
    expect(await gateFake().calls()).toEqual([['dropSessions', i.id, { userId: o.user }]]);
    const { results } = await E.DB.prepare(`SELECT team_id FROM instance_teams WHERE instance_id = ?`).bind(i.id).all();
    expect(results).toEqual([{ team_id: o.teamB }]);
  });

  it('refuses to take away the last team (D71)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(i.id, o.teamA).run();
    const r = await app.call('PUT', `/api/orgs/${o.orgId}/instances/${i.id}/teams`, { user: o.admin, body: { teamIds: [] } });
    expect(r).toEqual({ status: 409, json: { error: 'last_team' } });
    const { results } = await E.DB.prepare(`SELECT team_id FROM instance_teams WHERE instance_id = ?`).bind(i.id).all();
    expect(results).toEqual([{ team_id: o.teamA }]);
    expect(await gateFake().calls()).toEqual([]);
  });
});

describe('upgrade (D26)', () => {
  it('starts an upgrade to the latest version only when a tenant admin asks', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.7.0' });
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.user, body: {} })).status).toBe(403);
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: {} });
    expect(r).toEqual({ status: 202, json: { ok: true, status: 'upgrading', version: '1.9.0' } });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'upgrading', target_version: '1.9.0' });
    expect(await gateFake().calls()).toEqual([['setStatus', i.id, 'upgrading']]);
    expect(recorded.ops).toEqual([{ op: 'upgrade', instanceId: i.id, actorId: o.admin, version: '1.9.0' }]);
    // Already upgrading: refused.
    expect((await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: {} })).status).toBe(409);
  });

  it('rejects malformed and unpublished versions', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.7.0' });
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`;
    for (const version of ['latest', '1.8.0-evil', 'evil@sha256:abc', '../1.8.0']) {
      expect(await app.call('POST', path, { user: o.admin, body: { version } })).toEqual({ status: 400, json: { error: 'invalid_version' } });
    }
    expect(await app.call('POST', path, { user: o.admin, body: { version: '9.9.9' } })).toEqual({ status: 400, json: { error: 'unknown_version' } });
    expect((await instanceRow(i.id))?.status).toBe('running');
    expect(recorded.ops).toEqual([]);
  });
});

describe('version picker (D26)', () => {
  /** Releases 1.8.0 (below the hosted minimum), 1.9.0, 1.9.1 and 1.9.2 (latest); 1.9.3 is not published. */
  let saved: { releases: unknown[]; setting: unknown[] } | null = null;
  async function seedReleases() {
    saved = {
      releases: (await E.DB.prepare(`SELECT * FROM worca_releases`).all()).results,
      setting: (await E.DB.prepare(`SELECT * FROM platform_settings WHERE key = 'worca_version'`).all()).results,
    };
    const now = Date.now();
    await E.DB.batch([
      E.DB.prepare(`INSERT OR REPLACE INTO worca_releases (version, published_at, published_by) VALUES ('1.8.0', 1, NULL), ('1.9.0', NULL, NULL), ('1.9.1', 2000, 'staff'), ('1.9.2', 3000, 'staff')`),
      E.DB.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('worca_version', '1.9.2', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(now),
    ]);
  }
  // D1 state outlives a test here: put the releases and the latest back for the other tests.
  afterEach(async () => {
    if (!saved) return;
    const { releases, setting } = saved as {
      releases: { version: string; published_at: number | null; published_by: string | null }[];
      setting: { key: string; value: string; updated_at: number }[];
    };
    saved = null;
    await E.DB.batch([
      E.DB.prepare(`DELETE FROM worca_releases`),
      E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'worca_version'`),
      ...releases.map((r) => E.DB.prepare(`INSERT INTO worca_releases (version, published_at, published_by) VALUES (?, ?, ?)`).bind(r.version, r.published_at, r.published_by)),
      ...setting.map((r) => E.DB.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)`).bind(r.key, r.value, r.updated_at)),
    ]);
  });

  it('lists the deployable published versions, newest first, to tenant admins only', async () => {
    await seedReleases();
    const o = await seedOrg();
    const other = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.1', available_version: '1.9.2', deployed_images: JSON.stringify(imagesFor('1.9.1', imageSources(E))) });
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/versions`;
    const r = await app.call('GET', path, { user: o.admin });
    expect(r).toEqual({
      status: 200,
      json: {
        current: '1.9.1',
        latest: '1.9.2',
        releaseCandidates: false,
        versions: [
          { version: '1.9.2', latest: true, current: false, rc: false, publishedAt: 3000, direction: 'upgrade' },
          { version: '1.9.1', latest: false, current: true, rc: false, publishedAt: 2000, direction: 'current' },
          { version: '1.9.0', latest: false, current: false, rc: false, publishedAt: null, direction: 'downgrade' },
        ],
      },
    });
    expect((await app.call('GET', path, { user: o.user })).status).toBe(403);
    expect((await app.call('GET', path, { user: other.admin })).status).toBe(404);
    expect((await app.call('GET', `/api/orgs/${other.orgId}/instances/${i.id}/versions`, { user: other.admin })).status).toBe(404);
    expect((await app.call('GET', path, {})).status).toBe(401);
  });

  it('moves to an older published version as a downgrade and audits the direction', async () => {
    await seedReleases();
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.2' });
    const r = await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: { version: '1.9.0' } });
    expect(r).toEqual({ status: 202, json: { ok: true, status: 'upgrading', version: '1.9.0' } });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'upgrading', target_version: '1.9.0' });
    expect(recorded.ops).toEqual([{ op: 'upgrade', instanceId: i.id, actorId: o.admin, version: '1.9.0' }]);
    expect(recorded.auditOrg).toMatchObject([
      { action: 'instance.upgrade_started', targetId: i.id, details: { from: '1.9.2', to: '1.9.0', direction: 'downgrade' } },
    ]);
  });

  it('audits an upgrade as such, and refuses the running, unpublished and too-old versions', async () => {
    await seedReleases();
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.9.1', deployed_images: JSON.stringify(imagesFor('1.9.1', imageSources(E))) });
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`;
    expect(await app.call('POST', path, { user: o.admin, body: { version: '1.9.1' } })).toEqual({ status: 409, json: { error: 'already_on_version' } });
    for (const version of ['1.9.3', '1.8.0', '1.7.0']) {
      expect(await app.call('POST', path, { user: o.admin, body: { version } })).toEqual({ status: 400, json: { error: 'unknown_version' } });
    }
    expect(recorded.ops).toEqual([]);
    expect((await app.call('POST', path, { user: o.admin, body: { version: '1.9.2' } })).status).toBe(202);
    expect(recorded.auditOrg[0]?.details).toEqual({ from: '1.9.1', to: '1.9.2', direction: 'upgrade' });
  });
});

describe('delete (D29, D30, D60)', () => {
  it('needs an MFA session and the typed name, then starts an emailed confirmation (D24)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'stopped' });
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/delete`;
    expect(await app.call('POST', path, { user: o.admin, body: { confirmName: 'Main' }, headers: { 'x-test-mfa': '0' } })).toEqual({
      status: 403, json: { error: 'mfa_required' },
    });
    expect(await app.call('POST', path, { user: o.admin, body: { confirmName: 'Wrong' } })).toEqual({ status: 422, json: { error: 'confirm_name_mismatch' } });
    expect(await app.call('POST', path, { user: o.admin, body: {} })).toEqual({ status: 400, json: { error: 'invalid_body' } });
    expect((await app.call('POST', path, { user: o.user, body: { confirmName: 'Main' } })).status).toBe(403);
    expect(recorded.confirmations).toEqual([]);
    const r = await app.call('POST', path, { user: o.admin, body: { confirmName: 'Main' } });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ status: 'confirmation_sent', confirmationId: 'c1', expiresAt: expect.any(Number) });
    expect(recorded.confirmations).toMatchObject([{ userId: o.admin, orgId: o.orgId, action: 'instance.delete', target: i.id }]);
    expect((await instanceRow(i.id))?.status).toBe('stopped'); // nothing happens before the confirmation
  });

  it('still accepts the older { name } body', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    const path = `/api/orgs/${o.orgId}/instances/${i.id}/delete`;
    expect((await app.call('POST', path, { user: o.admin, body: { name: 'Wrong' } })).json).toEqual({ error: 'confirm_name_mismatch' });
    expect((await app.call('POST', path, { user: o.admin, body: { name: 'Main' } })).status).toBe(202);
  });
});

describe('heartbeat', () => {
  const post = (credential: string | null, body: unknown) =>
    app.call('POST', '/api/heartbeat', { body, headers: credential ? { authorization: `Bearer ${credential}` } : {} });

  it('rejects missing or unknown credentials and bad bodies', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect((await post(null, beat())).status).toBe(401);
    expect((await post('nope', beat())).status).toBe(401);
    expect((await post(i.credential, { ...beat(), suspendable: 'yes' })).status).toBe(400);
  });

  it('stores the beat and forwards suspendable and next run to the gate (D28, D56)', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { health: 'degraded', last_heartbeat_at: 1 });
    const r = await post(i.credential, beat({ version: '1.8.1', nextScheduledAt: 1_900_000_000, suspendable: false, pipelines: { running: 1 } }));
    expect(r.json).toEqual({ ok: true, ignored: false, status: 'running', transitioned: false });
    expect(await instanceRow(i.id)).toMatchObject({ health: 'ok', worca_version: '1.8.1' });
    expect(await E.DB.prepare(`SELECT * FROM heartbeats WHERE instance_id = ?`).bind(i.id).first()).toMatchObject({
      pipelines: '{"running":1}', suspendable: 0, next_scheduled_at: 1_900_000_000,
    });
    expect(await gateFake().calls()).toEqual([
      ['setStatus', i.id, 'running', ['creating']], // repairs only a gate still showing creating
      ['heartbeat', i.id, { suspendable: false, nextScheduledAt: 1_900_000_000 }],
    ]);
  });

  it('moves creating, waking, lifting and upgrading instances to running', async () => {
    const o = await seedOrg();
    const creating = await seedInstance(o.orgId, { status: 'creating' });
    const waking = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake' });
    const lifting = await seedInstance(o.orgId, { status: 'stopped', pending_op: 'lift', stopped_reason: 'spam', stopped_by: 'x' });
    const upgrading = await seedInstance(o.orgId, { status: 'upgrading', target_version: '1.9.0', worca_version: '1.8.0' });
    for (const i of [creating, waking, lifting]) {
      expect((await post(i.credential, beat())).json.status).toBe('running');
      expect(await instanceRow(i.id)).toMatchObject({ status: 'running', pending_op: null, stopped_reason: null });
    }
    // Old version still reporting: stays upgrading.
    expect((await post(upgrading.credential, beat({ version: '1.8.0' }))).json.status).toBe('upgrading');
    expect((await post(upgrading.credential, beat({ version: '1.9.0' }))).json.status).toBe('running');
    expect(await instanceRow(upgrading.id)).toMatchObject({ status: 'running', worca_version: '1.9.0', target_version: null });
    const statuses = (await gateFake().calls()).filter((c) => c[0] === 'setStatus');
    expect(statuses).toEqual([creating, waking, lifting, upgrading].map((i) => ['setStatus', i.id, 'running']));
  });

  it('ignores beats of stopped and deleting instances, and of suspended ones not being woken', async () => {
    const o = await seedOrg();
    const stopped = await seedInstance(o.orgId, { status: 'stopped' });
    const deleting = await seedInstance(o.orgId, { status: 'deleting' });
    const suspended = await seedInstance(o.orgId, { status: 'suspended' });
    expect((await post(stopped.credential, beat())).json).toMatchObject({ ignored: true, status: 'stopped' });
    expect((await post(deleting.credential, beat())).json).toMatchObject({ ignored: true, status: 'deleting' });
    expect((await post(suspended.credential, beat())).json).toMatchObject({ ignored: false, status: 'suspended', transitioned: false });
    expect((await gateFake().calls()).filter((c) => c[0] === 'setStatus')).toEqual([]);
  });
});

describe('suspend and wake (D27, D47)', () => {
  it('suspends only running instances whose latest beat is suspendable, once', async () => {
    const o = await seedOrg();
    const busy = await seedInstance(o.orgId);
    const idle = await seedInstance(o.orgId);
    const app2 = testApp();
    await app2.call('POST', '/api/heartbeat', { body: beat({ suspendable: false }), headers: { authorization: `Bearer ${busy.credential}` } });
    await app2.call('POST', '/api/heartbeat', { body: beat({ suspendable: true }), headers: { authorization: `Bearer ${idle.credential}` } });
    await requestSuspend(E, ctx(), busy.id);
    await requestSuspend(E, ctx(), idle.id);
    await requestSuspend(E, ctx(), idle.id);
    expect(recorded.ops).toEqual([{ op: 'suspend', instanceId: idle.id, actorId: null }]);
    expect((await instanceRow(idle.id))?.pending_op).toBe('suspend');
  });

  it('wakes suspended instances once and never stopped ones', async () => {
    const o = await seedOrg();
    const suspended = await seedInstance(o.orgId, { status: 'suspended' });
    const stopped = await seedInstance(o.orgId, { status: 'stopped' });
    await requestWake(E, ctx(), suspended.id, 'visit');
    await requestWake(E, ctx(), suspended.id, 'visit');
    await requestWake(E, ctx(), stopped.id, 'visit');
    expect(recorded.ops).toEqual([{ op: 'wake', instanceId: suspended.id, actorId: null }]);
  });
});

describe('stop for abuse and lift (D16, D47)', () => {
  it('stops at the gate at once, notifies admins, and only a lift plus a beat brings it back', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await stopForAbuse(E, i.id, { actorId: 'staff', reason: 'crypto mining' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'stopped', stopped_reason: 'crypto mining', stopped_by: 'staff' });
    expect(await gateFake().calls()).toEqual([['setStatus', i.id, 'stopped']]);
    expect(recorded.ops).toEqual([{ op: 'stop', instanceId: i.id, actorId: 'staff' }]);
    expect(recorded.mails.map((m) => m.to)).toEqual([`${o.admin}@example.com`]);
    expect(recorded.auditOrg[0]).toMatchObject({ orgId: o.orgId, action: 'instance.stopped', actorScope: 'platform' });
    await expect(stopForAbuse(E, i.id, { actorId: 'staff', reason: 'again' })).rejects.toThrow('instance_not_stoppable');

    // A visit never wakes it.
    await requestWake(E, ctx(), i.id, 'visit');
    expect(recorded.ops).toHaveLength(1);

    await liftStop(E, i.id, { actorId: 'staff' });
    expect(recorded.ops[1]).toEqual({ op: 'lift', instanceId: i.id, actorId: 'staff' });
    await testApp().call('POST', '/api/heartbeat', { body: beat(), headers: { authorization: `Bearer ${i.credential}` } });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', stopped_reason: null, pending_op: null });
  });
});

describe('crons', () => {
  it('marks running instances with a stale heartbeat degraded, never suspended or stopped ones', async () => {
    const o = await seedOrg();
    const now = Date.now();
    const stale = await seedInstance(o.orgId, { last_heartbeat_at: now - 6 * 60_000 });
    const fresh = await seedInstance(o.orgId, { last_heartbeat_at: now - 60_000 });
    const suspended = await seedInstance(o.orgId, { status: 'suspended', last_heartbeat_at: now - 3_600_000 });
    const stopped = await seedInstance(o.orgId, { status: 'stopped', last_heartbeat_at: now - 3_600_000 });
    await markStale(E, now);
    expect((await instanceRow(stale.id))?.health).toBe('degraded');
    for (const i of [fresh, suspended, stopped]) expect((await instanceRow(i.id))?.health).toBe('ok');
  });

  it('runs each cron slot once, however often it is delivered', async () => {
    const o = await seedOrg();
    const scheduledTime = Date.UTC(2026, 9, 6, 12, 7, 0);
    const stale = await seedInstance(o.orgId, { last_heartbeat_at: scheduledTime - 10 * 60_000 });
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime }), E, ctx());
    expect((await instanceRow(stale.id))?.health).toBe('degraded');
    await E.DB.prepare(`UPDATE instances SET health = 'ok' WHERE id = ?`).bind(stale.id).run();
    // Duplicate delivery 25 s later, same 5-minute slot: skipped.
    await runCrons(createScheduledController({ cron: CRON_STALE, scheduledTime: scheduledTime + 25_000 }), E, ctx());
    expect((await instanceRow(stale.id))?.health).toBe('ok');
    const { results } = await E.DB.prepare(`SELECT slot FROM cron_runs WHERE cron = ?`).bind(CRON_STALE).all();
    expect(results).toEqual([{ slot: '2026-10-06T12:05' }]);
  });

  it('daily: prunes and records the available version', async () => {
    const o = await seedOrg();
    const old = await seedInstance(o.orgId, { worca_version: '1.7.0' });
    let pruned = 0;
    setInstancesDeps({ pruneAudit: async () => void pruned++, pruneGateCodes: async () => void pruned++ });
    await E.DB.prepare(`INSERT INTO cron_runs (cron, slot, at) VALUES ('x', 'old', 1)`).run();
    await runCrons(createScheduledController({ cron: CRON_DAILY, scheduledTime: Date.UTC(2026, 9, 7, 3, 17) }), E, ctx());
    expect(pruned).toBe(2);
    expect((await instanceRow(old.id))?.available_version).toBe('1.9.0');
    expect(await E.DB.prepare(`SELECT 1 FROM cron_runs WHERE cron = 'x'`).first()).toBeNull();
  });
});

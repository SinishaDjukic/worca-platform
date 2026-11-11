// D80: release candidates. Enrolled from npm like releases but never the latest and offered to
// nobody; tenant admins of an org with release candidates on pin instances to one by hand, and
// nothing moves a pinned instance automatically (src/control/instances/images.ts, releases.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoUpdate } from '../../../packages/platform/src/control/instances/auto-update';
import {
  compareVersions, deployableVersions, imageSources, isPublishedVersion, isRc, latestWorcaVersion, needsRefresh, releaseCandidates,
} from '../../../packages/platform/src/control/instances/images';
import { checkNpmReleases, markAvailableVersion } from '../../../packages/platform/src/control/instances/releases';
import { fakeRegistry } from './fake-registry';
import { E, gateFake, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const NOW = Date.now();

const setLatest = (v: string) =>
  E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_version', ?, 0)`).bind(v).run();
const record = (v: string, source = 'npm') =>
  E.DB.prepare('INSERT INTO worca_releases (version, published_at, published_by, source) VALUES (?, ?, NULL, ?)').bind(v, NOW - 60_000, source).run();
const release = (v: string) => E.DB.prepare('SELECT * FROM worca_releases WHERE version = ?').bind(v).first<Record<string, any>>();
const rcAccess = (orgId: string, on: boolean) =>
  E.DB.prepare(
    `INSERT INTO org_settings (org_id, tier, status, created_at, rc_access) VALUES (?1, 'free', 'active', 0, ?2)
      ON CONFLICT (org_id) DO UPDATE SET rc_access = excluded.rc_access`,
  )
    .bind(orgId, on ? 1 : 0)
    .run();
const beat = (id: string, version: string) =>
  E.DB.prepare(
    `INSERT OR REPLACE INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, ?, 'ok', ?, '{}', NULL, 1)`,
  )
    .bind(id, NOW - 60_000, version)
    .run();

async function clean() {
  await E.DB.batch([
    E.DB.prepare('DELETE FROM worca_releases'),
    E.DB.prepare('DELETE FROM release_holds'),
    E.DB.prepare(`DELETE FROM platform_settings WHERE key IN ('worca_version', 'release_auto_enroll', 'auto_update_soak_hours', 'release_enroll_floor')`),
    E.DB.prepare(`UPDATE instances SET auto_update = 'off', worca_version = '1.8.0', available_version = NULL`),
  ]);
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
  await clean();
  await setLatest('1.14.0');
  await record('1.14.0', 'manual');
});
afterEach(clean);

describe('versions', () => {
  it('orders a candidate after the release before it and before its own release', () => {
    const sorted = ['1.10.0', '1.10.0-rc.2', '1.9.0', '1.10.0-rc.10', '1.10.0-rc.1', '1.10.1'].sort(compareVersions);
    expect(sorted).toEqual(['1.9.0', '1.10.0-rc.1', '1.10.0-rc.2', '1.10.0-rc.10', '1.10.0', '1.10.1']);
    expect(isRc('1.10.0-rc.1')).toBe(true);
    for (const v of ['1.10.0', '1.10.0-rc1', '1.10.0-beta.1', '1.10.0-rc.', 'rc']) expect(isRc(v)).toBe(false);
  });
});

describe('enrolling from npm', () => {
  it('records candidates of releases not out yet, never as the latest, offered to nobody', async () => {
    const o = await seedOrg();
    const older = await seedInstance(o.orgId, { worca_version: '1.13.0' });
    const reg = fakeRegistry();
    // 1.14.0-rc.3 and 1.15.0-rc.1 are candidates of releases already on npm: skipped.
    reg.state.npm = ['1.14.0-rc.3', '1.14.0', '1.15.0-rc.1', '1.15.0', '1.16.0-rc.1', '1.16.0-rc.2'];
    reg.images.set('1.15.0', {}).set('1.16.0-rc.1', {}).set('1.16.0-rc.2', {});
    const out = await checkNpmReleases(E, NOW, reg.fetch);
    expect(out).toEqual({ enrolled: ['1.15.0', '1.16.0-rc.1', '1.16.0-rc.2'], held: [] });
    expect(await release('1.15.0-rc.1')).toBeNull();
    expect(await release('1.16.0-rc.2')).toMatchObject({ source: 'npm', published_by: null, withdrawn_at: null });
    expect(await latestWorcaVersion(E)).toBe('1.15.0');
    expect((await instanceRow(older.id))?.available_version).toBe('1.15.0');
    const audit = recorded.auditPlatform.filter((a) => a.action === 'platform.release_enrolled');
    expect(audit.find((a) => a.targetId === '1.16.0-rc.2')?.details).toEqual({ source: 'npm', rc: true });
    expect((await releaseCandidates(E)).map((v) => v.version)).toEqual(['1.16.0-rc.2', '1.16.0-rc.1']);
  });

  it('holds a candidate whose image is missing, like a release', async () => {
    const reg = fakeRegistry();
    reg.state.npm = ['1.15.0-rc.1'];
    expect((await checkNpmReleases(E, NOW, reg.fetch)).held).toEqual([{ version: '1.15.0-rc.1', reason: 'image_missing' }]);
  });

  it('candidates leave the list once their release is out, and never pass for releases', async () => {
    await record('1.15.0-rc.1');
    expect(await isPublishedVersion(E, '1.15.0-rc.1', null)).toBe(false); // not without { rc }
    expect(await isPublishedVersion(E, '1.15.0-rc.1', null, { rc: true })).toBe(true);
    expect((await deployableVersions(E, null)).versions.map((v) => v.version)).toEqual(['1.14.0']);
    expect((await deployableVersions(E, null, { rc: true })).versions).toEqual([
      { version: '1.15.0-rc.1', publishedAt: expect.any(Number), rc: true },
      { version: '1.14.0', publishedAt: expect.any(Number) },
    ]);
    await record('1.15.0');
    await setLatest('1.15.0');
    expect(await releaseCandidates(E)).toEqual([]);
    // Still enrolled: an instance on it can be refreshed and rolled back to it.
    expect(await isPublishedVersion(E, '1.15.0-rc.1', null, { rc: true })).toBe(true);
  });
});

describe('pinning', () => {
  it('only an org with release candidates on sees and picks them', async () => {
    await record('1.15.0-rc.1');
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.14.0' });
    const path = `/api/orgs/${o.orgId}/instances/${i.id}`;

    const off = await app.call('GET', `${path}/versions`, { user: o.admin });
    expect(off.json.releaseCandidates).toBe(false);
    expect(off.json.versions.map((v: { version: string }) => v.version)).toEqual(['1.14.0']);
    expect(await app.call('POST', `${path}/upgrade`, { user: o.admin, body: { version: '1.15.0-rc.1' } })).toMatchObject({
      status: 403, json: { error: 'release_candidates_off' },
    });

    await rcAccess(o.orgId, true);
    const on = await app.call('GET', `${path}/versions`, { user: o.admin });
    expect(on.json.versions).toEqual([
      expect.objectContaining({ version: '1.15.0-rc.1', rc: true, latest: false, direction: 'upgrade' }),
      expect.objectContaining({ version: '1.14.0', rc: false, latest: true, current: true }),
    ]);
    expect(await app.call('POST', `${path}/upgrade`, { user: o.admin, body: { version: '1.15.0-rc.9' } })).toMatchObject({
      status: 400, json: { error: 'unknown_version' },
    });
    const up = await app.call('POST', `${path}/upgrade`, { user: o.admin, body: { version: '1.15.0-rc.1' } });
    expect(up).toMatchObject({ status: 202, json: { status: 'upgrading', version: '1.15.0-rc.1' } });
    expect(recorded.ops.at(-1)).toMatchObject({ op: 'upgrade', instanceId: i.id, version: '1.15.0-rc.1' });
    expect(await instanceRow(i.id)).toMatchObject({ status: 'upgrading', target_version: '1.15.0-rc.1' });
  });

  it('a pinned instance shows it, is never updated automatically and is offered only a newer release', async () => {
    await record('1.15.0-rc.1');
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.15.0-rc.1', auto_update: 'micro', auto_update_minor: 1, updated_at: 0 });
    await beat(i.id, '1.15.0-rc.1');
    const view = await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin });
    expect(view.json).toMatchObject({ version: '1.15.0-rc.1', releaseCandidate: true, availableVersion: null });

    // The latest (1.14.0) is older: not offered as an upgrade.
    await markAvailableVersion(E);
    expect((await instanceRow(i.id))?.available_version).toBeNull();
    expect(await autoUpdate(E, NOW)).toEqual([]);

    // The release comes out: offered, still never installed automatically.
    await record('1.15.0');
    await setLatest('1.15.0');
    await markAvailableVersion(E);
    expect((await instanceRow(i.id))?.available_version).toBe('1.15.0');
    expect(await autoUpdate(E, NOW)).toEqual([]);
    expect(recorded.ops).toEqual([]);

    // The tenant admin moves it; that is an upgrade.
    const versions = await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}/versions`, { user: o.admin });
    expect(versions.json.versions.find((v: { version: string }) => v.version === '1.15.0').direction).toBe('upgrade');
    const up = await app.call('POST', `/api/orgs/${o.orgId}/instances/${i.id}/upgrade`, { user: o.admin, body: {} });
    expect(up).toMatchObject({ status: 202, json: { version: '1.15.0' } });
  });

  it('the cloudflared refresh still reaches an instance on a candidate', () => {
    const want = 'ghcr.io/sinishadjukic/worca:1.15.0-rc.1';
    expect(needsRefresh({ worca_version: '1.15.0-rc.1', deployed_images: JSON.stringify({ worca: want, broker: want, cloudflared: 'cloudflare/cloudflared:old' }) }, imageSources(E))).toBe(true);
  });
});

// D77: releases enrolled from npm, withdrawn and restored by superadmins, and the soak time of
// automatic updates (src/control/instances/releases.ts, registry.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoUpdate } from '../../../packages/platform/src/control/instances/auto-update';
import { deployableVersions, isPublishedVersion, latestWorcaVersion } from '../../../packages/platform/src/control/instances/images';
import { checkImage } from '../../../packages/platform/src/control/instances/registry';
import { DEFAULT_WORCA_IMAGE } from '../../../packages/platform/src/control/instances/images';
import {
  autoUpdateTarget, checkNpmReleases, ENROLL_PER_TICK, releaseSettings, restoreRelease, setReleaseSettings, withdrawRelease,
} from '../../../packages/platform/src/control/instances/releases';
import { fakeRegistry } from './fake-registry';
import { E, gateFake, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const HOUR = 3_600_000;
const NOW = Date.now();
const staff = { id: 'root', role: 'superadmin' };

const setLatest = (v: string) =>
  E.DB.prepare(`INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES ('worca_version', ?, 0)`).bind(v).run();
const record = (v: string, at: number | null, source = 'manual') =>
  E.DB.prepare('INSERT INTO worca_releases (version, published_at, published_by, source) VALUES (?, ?, NULL, ?)').bind(v, at, source).run();
const release = (v: string) => E.DB.prepare('SELECT * FROM worca_releases WHERE version = ?').bind(v).first<Record<string, any>>();
const hold = (v: string) => E.DB.prepare('SELECT * FROM release_holds WHERE version = ?').bind(v).first<Record<string, any>>();

async function clean() {
  await E.DB.batch([
    E.DB.prepare('DELETE FROM worca_releases'),
    E.DB.prepare('DELETE FROM release_holds'),
    E.DB.prepare(`DELETE FROM platform_settings WHERE key IN ('worca_version', 'worca_released_versions', 'release_auto_enroll', 'auto_update_soak_hours', 'release_enroll_floor')`),
    // Earlier tests' instances never take part.
    E.DB.prepare(`UPDATE instances SET auto_update = 'off', worca_version = '1.8.0', available_version = NULL`),
  ]);
}

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
  await clean();
  await setLatest('1.14.0');
  await record('1.14.0', NOW - 10 * 24 * HOUR);
});
afterEach(clean);

describe('the image check', () => {
  it('follows the index to the linux/amd64 config and compares the version label', async () => {
    const reg = fakeRegistry();
    reg.images.set('1.16.0', {});
    expect(await checkImage('1.16.0', reg.fetch, DEFAULT_WORCA_IMAGE)).toEqual({ status: 'ok' });
    expect(reg.requests.map((r) => r.url)).toEqual([
      'https://ghcr.io/token?scope=repository:sinishadjukic/worca:pull&service=ghcr.io',
      'https://ghcr.io/v2/sinishadjukic/worca/manifests/1.16.0',
      'https://ghcr.io/v2/sinishadjukic/worca/manifests/sha256:idx-1.16.0',
      'https://ghcr.io/v2/sinishadjukic/worca/blobs/sha256:cfg-1.16.0',
    ]);
    expect(reg.requests[1]?.headers.get('authorization')).toBe('Bearer anon-token');
    // 1.14.0 was the 1.14.0-rc.4 image retagged: its heartbeat never says 1.14.0.
    reg.images.set('1.14.0', { label: '1.14.0-rc.4' });
    expect(await checkImage('1.14.0', reg.fetch, DEFAULT_WORCA_IMAGE)).toEqual({ status: 'mismatch', label: '1.14.0-rc.4' });
    reg.images.set('1.13.0', { label: null });
    expect(await checkImage('1.13.0', reg.fetch, DEFAULT_WORCA_IMAGE)).toEqual({ status: 'mismatch', label: null });
    expect(await checkImage('9.9.9', reg.fetch, DEFAULT_WORCA_IMAGE)).toEqual({ status: 'missing' });
    reg.images.set('1.17.0', { status: 503 });
    expect(await checkImage('1.17.0', reg.fetch, DEFAULT_WORCA_IMAGE)).toEqual({ status: 'unavailable' });
  });
});

describe('enrolling from npm', () => {
  it('enrolls stable versions above the floor, oldest first, and offers the newest as the latest', async () => {
    const o = await seedOrg();
    const old = await seedInstance(o.orgId, { worca_version: '1.13.1' });
    const reg = fakeRegistry();
    reg.state.npm = ['1.9.2', '1.13.1', '1.14.0', '1.15.0-rc.2', '1.15.0', '1.16.0-rc.1', '1.16.0'];
    reg.images.set('1.15.0', {}).set('1.16.0', {});
    const out = await checkNpmReleases(E, NOW, reg.fetch);
    expect(out).toEqual({ enrolled: ['1.15.0', '1.16.0'], held: [] });
    // The floor is the latest of the first check: older versions were the staff's to choose.
    expect(await E.DB.prepare(`SELECT value FROM platform_settings WHERE key = 'release_enroll_floor'`).first()).toEqual({ value: '1.14.0' });
    expect(await release('1.9.2')).toBeNull();
    expect(await release('1.16.0')).toMatchObject({ source: 'npm', published_by: null, published_at: NOW, withdrawn_at: null });
    expect(await latestWorcaVersion(E)).toBe('1.16.0');
    expect((await instanceRow(old.id))?.available_version).toBe('1.16.0');
    expect(recorded.auditPlatform.filter((a) => a.action === 'platform.release_enrolled').map((a) => a.targetId)).toEqual(['1.15.0', '1.16.0']);
    // The next tick has nothing to do: no GHCR requests.
    reg.requests.length = 0;
    expect(await checkNpmReleases(E, NOW + 1, reg.fetch)).toEqual({ enrolled: [], held: [] });
    expect(reg.requests.map((r) => r.url)).toEqual(['https://registry.npmjs.org/@worca%2fapp']);
  });

  it('a backport becomes deployable without replacing the latest', async () => {
    await E.DB.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('release_enroll_floor', '1.13.0', 0)`).run();
    const reg = fakeRegistry();
    reg.state.npm = ['1.13.2', '1.14.0'];
    reg.images.set('1.13.2', {});
    expect((await checkNpmReleases(E, NOW, reg.fetch)).enrolled).toEqual(['1.13.2']);
    expect(await latestWorcaVersion(E)).toBe('1.14.0');
    expect(await isPublishedVersion(E, '1.13.2', null)).toBe(true);
  });

  it('holds a version until its image is on GHCR, and for good when the image reports another version', async () => {
    const reg = fakeRegistry();
    reg.state.npm = ['1.15.0', '1.16.0', '1.17.0'];
    reg.images.set('1.16.0', { label: '1.16.0-rc.1' }).set('1.17.0', { status: 503 });
    expect((await checkNpmReleases(E, NOW, reg.fetch)).held).toEqual([
      { version: '1.15.0', reason: 'image_missing' },
      { version: '1.16.0', reason: 'label_mismatch' },
      { version: '1.17.0', reason: 'registry_unavailable' },
    ]);
    expect(await hold('1.16.0')).toMatchObject({ reason: 'label_mismatch', detail: '1.16.0-rc.1' });
    expect(recorded.auditPlatform.filter((a) => a.action === 'platform.release_held').map((a) => a.targetId)).toEqual(['1.16.0']);
    expect(await latestWorcaVersion(E)).toBe('1.14.0');

    // The image arrives: enrolled, the hold cleared. The mismatched one isn't asked about again.
    reg.images.set('1.15.0', {}).set('1.17.0', {});
    reg.requests.length = 0;
    const later = await checkNpmReleases(E, NOW + 5 * 60_000, reg.fetch);
    expect(later.enrolled).toEqual(['1.15.0', '1.17.0']);
    expect(await hold('1.15.0')).toBeNull();
    expect(reg.requests.some((r) => r.url.includes('1.16.0'))).toBe(false);
    expect(await latestWorcaVersion(E)).toBe('1.17.0');
  });

  it(`checks at most ${ENROLL_PER_TICK} versions per tick`, async () => {
    const reg = fakeRegistry();
    reg.state.npm = ['1.15.0', '1.15.1', '1.15.2', '1.15.3', '1.16.0'];
    for (const v of reg.state.npm) reg.images.set(v, {});
    expect((await checkNpmReleases(E, NOW, reg.fetch)).enrolled).toEqual(['1.15.0', '1.15.1', '1.15.2']);
    expect((await checkNpmReleases(E, NOW, reg.fetch)).enrolled).toEqual(['1.15.3', '1.16.0']);
  });

  it('does nothing when switched off, and never brings back a withdrawn release', async () => {
    const reg = fakeRegistry();
    reg.state.npm = ['1.15.0'];
    reg.images.set('1.15.0', {});
    await setReleaseSettings(E, { autoEnroll: false, soakHours: 24 });
    expect(await checkNpmReleases(E, NOW, reg.fetch)).toEqual({ enrolled: [], held: [] });
    expect(reg.requests).toEqual([]);

    await setReleaseSettings(E, { autoEnroll: true, soakHours: 24 });
    await record('1.15.0', NOW - HOUR, 'npm');
    expect((await withdrawRelease(E, '1.15.0', staff, 'CVE-2026-1')).ok).toBe(true);
    expect(await checkNpmReleases(E, NOW, reg.fetch)).toEqual({ enrolled: [], held: [] });
    expect(await release('1.15.0')).toMatchObject({ withdrawn_reason: 'CVE-2026-1' });
  });

  it('an npm outage fails the check (the cron logs it) without changing anything', async () => {
    const reg = fakeRegistry();
    reg.state.npmStatus = 503;
    await expect(checkNpmReleases(E, NOW, reg.fetch)).rejects.toThrow(/503/);
    expect(await latestWorcaVersion(E)).toBe('1.14.0');
  });

  it('settings default to on and no soak time, and reject nonsense stored values', async () => {
    expect(await releaseSettings(E)).toEqual({ autoEnroll: true, soakHours: 0 });
    await E.DB.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('auto_update_soak_hours', 'x', 0)`).run();
    expect((await releaseSettings(E)).soakHours).toBe(0);
  });
});

describe('withdrawing', () => {
  it('takes the latest out: the newest left is the latest, nothing deploys it, the org admins are told', async () => {
    await record('1.15.0', NOW - 5 * 24 * HOUR);
    await record('1.16.0', NOW - HOUR, 'npm');
    await setLatest('1.16.0');
    const o = await seedOrg();
    const on = await seedInstance(o.orgId, { worca_version: '1.16.0', display_name: 'enc:Main' });
    const older = await seedInstance(o.orgId, { worca_version: '1.14.0', available_version: '1.16.0' });

    const r = await withdrawRelease(E, '1.16.0', staff, 'Leaks the broker secret in logs.');
    expect(r).toEqual({ ok: true, latest: '1.15.0', instances: 1, orgsNotified: 1 });
    expect(await latestWorcaVersion(E)).toBe('1.15.0');
    expect(await isPublishedVersion(E, '1.16.0', '1.16.0')).toBe(false);
    expect((await deployableVersions(E, '1.16.0')).versions.map((v) => v.version)).not.toContain('1.16.0');
    expect((await instanceRow(older.id))?.available_version).toBe('1.15.0');
    // The instance on it keeps running; it is offered the way out.
    expect(await instanceRow(on.id)).toMatchObject({ status: 'running', worca_version: '1.16.0', available_version: '1.15.0' });

    const mail = recorded.mails.find((m) => m.to === `${o.admin}@example.com`);
    expect(mail?.subject).toBe('Worca 1.16.0 was withdrawn: your instance Main runs it');
    expect(mail?.text).toContain('Reason: Leaks the broker secret in logs.');
    expect(mail?.text).toContain('change to 1.15.0');
    expect(recorded.mails.some((m) => m.to === `${o.user}@example.com`)).toBe(false); // admins only
    const audit = recorded.auditPlatform.find((a) => a.action === 'platform.release_withdrawn');
    expect(audit).toMatchObject({ targetType: 'release', targetId: '1.16.0', details: { latest: '1.15.0', instances: 1, orgs: 1 } });
    expect(JSON.stringify(audit)).not.toContain('broker secret'); // no free text in the platform log

    // Tenants see it, and can't pick it.
    const view = await app.call('GET', `/api/orgs/${o.orgId}/instances/${on.id}`, { user: o.admin });
    expect(view.json.versionWithdrawn).toEqual({ reason: 'Leaks the broker secret in logs.', withdrawnAt: expect.any(Number) });
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${older.id}`, { user: o.admin })).json.versionWithdrawn).toBeNull();
    const up = await app.call('POST', `/api/orgs/${o.orgId}/instances/${older.id}/upgrade`, { user: o.admin, body: { version: '1.16.0' } });
    expect(up).toMatchObject({ status: 400, json: { error: 'unknown_version' } });
  });

  it('refuses the last deployable release, a second withdrawal and an unknown one', async () => {
    expect(await withdrawRelease(E, '1.14.0', staff, 'x')).toEqual({ ok: false, error: 'last_release' });
    await record('1.13.1', null);
    expect((await withdrawRelease(E, '1.13.1', staff, 'x')).ok).toBe(true);
    expect(await withdrawRelease(E, '1.13.1', staff, 'x')).toEqual({ ok: false, error: 'already_withdrawn' });
    expect(await withdrawRelease(E, '1.99.0', staff, 'x')).toEqual({ ok: false, error: 'release_not_found' });
  });

  it('restoring makes it deployable again, and the latest again when newest', async () => {
    await record('1.15.0', NOW - HOUR, 'npm');
    await setLatest('1.15.0');
    await withdrawRelease(E, '1.15.0', staff, 'bad build');
    expect(await latestWorcaVersion(E)).toBe('1.14.0');
    expect(await restoreRelease(E, '1.15.0', staff)).toEqual({ ok: true, latest: '1.15.0' });
    expect(await isPublishedVersion(E, '1.15.0', null)).toBe(true);
    expect(await release('1.15.0')).toMatchObject({ withdrawn_at: null, withdrawn_reason: null });
    expect(await restoreRelease(E, '1.15.0', staff)).toEqual({ ok: false, error: 'not_withdrawn' });
  });
});

describe('automatic updates wait for the soak time', () => {
  it('take the newest release enrolled long enough ago', async () => {
    expect(await autoUpdateTarget(E, NOW)).toBe('1.14.0'); // no soak time by default
    await setReleaseSettings(E, { autoEnroll: true, soakHours: 24 });
    await record('1.15.0', NOW - 30 * HOUR, 'npm');
    await record('1.16.0', NOW - 2 * HOUR, 'npm');
    await setLatest('1.16.0');
    expect(await autoUpdateTarget(E, NOW)).toBe('1.15.0');
    expect(await autoUpdateTarget(E, NOW + 23 * HOUR)).toBe('1.16.0');
    await setReleaseSettings(E, { autoEnroll: true, soakHours: 0 });
    expect(await autoUpdateTarget(E, NOW)).toBe('1.16.0');
    await setReleaseSettings(E, { autoEnroll: true, soakHours: 48 });
    expect(await autoUpdateTarget(E, NOW)).toBe('1.14.0');
    // Never a withdrawn one.
    await setReleaseSettings(E, { autoEnroll: true, soakHours: 24 });
    await withdrawRelease(E, '1.15.0', staff, 'x');
    expect(await autoUpdateTarget(E, NOW)).toBe('1.14.0');
  });

  it('an idle instance with automatic updates on is updated to the settled release, not the fresh latest', async () => {
    await setReleaseSettings(E, { autoEnroll: true, soakHours: 24 });
    await record('1.14.1', NOW - 30 * HOUR, 'npm');
    await record('1.14.2', NOW - HOUR, 'npm');
    await setLatest('1.14.2');
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { worca_version: '1.14.0', auto_update: 'micro', updated_at: 0 });
    await E.DB.prepare(
      `INSERT INTO heartbeats (instance_id, received_at, health, worca_version, pipelines, next_scheduled_at, suspendable) VALUES (?, ?, 'ok', '1.14.0', '{}', NULL, 1)`,
    )
      .bind(i.id, NOW - 60_000)
      .run();
    expect(await autoUpdate(E, NOW)).toEqual([i.id]);
    expect(recorded.ops.at(-1)).toMatchObject({ op: 'upgrade', instanceId: i.id, version: '1.14.1', automatic: true });
  });
});

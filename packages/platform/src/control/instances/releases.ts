// Worca releases on the platform (D26 step 1, D77; docs/instance-lifecycle.md "Releases").
//
// A release is enrolled when it becomes deployable: recorded in `worca_releases` and, when it is
// newer than the latest, made the latest, which offers it to every older instance. Stable releases
// of @worca/app are enrolled from npm by the 5-minute cron once their image is on GHCR and reports
// the same version; a superadmin can still publish one by hand. A superadmin can withdraw a
// release (a vulnerability, a bad build): it stays recorded, so it is never enrolled again, but
// nothing is created, upgraded or downgraded to it, and the org admins of instances that run it are
// told. Withdrawing never moves an instance: they choose when (D26).
//
// D80: release candidates (x.y.z-rc.N, npm's rc tag) are enrolled the same way but never become
// the latest and are offered to nobody. Tenant admins of orgs a superadmin gave release candidates
// pin instances to one by hand; nothing moves a pinned instance automatically.
import type { Env } from '../env';
import { decryptDisplayName, hostFor, instanceUrl, notifyOrgAdmins, type InstanceRow } from './api';
import { deps } from './deps';
import { compareVersions, imageSources, isRc, isSemver, latestWorcaVersion, MIN_HOSTED_WORCA_VERSION, rcRunsHosted, releaseOf, runsHosted } from './images';
import { checkImage, npmVersions } from './registry';

export const SETTING_AUTO_ENROLL = 'release_auto_enroll';
export const SETTING_SOAK_HOURS = 'auto_update_soak_hours';
/** Set on the first check: versions up to it were the staff's to publish (old ones aren't enrolled). */
export const SETTING_ENROLL_FLOOR = 'release_enroll_floor';
/** None for now (product owner, 2026-11-01); superadmins can set one on the Releases page. */
export const DEFAULT_SOAK_HOURS = 0;
export const MAX_SOAK_HOURS = 24 * 30;
/** At most this many versions have their image checked per tick (four GHCR requests each). */
export const ENROLL_PER_TICK = 3;

export type HoldReason = 'image_missing' | 'registry_unavailable' | 'label_mismatch';

const UPSERT_SETTING =
  'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';

const newest = (versions: string[]): string | null =>
  versions.filter((v) => isSemver(v) && runsHosted(v)).sort((a, b) => compareVersions(b, a))[0] ?? null;

// ---- settings ----

export interface ReleaseSettings {
  /** Enroll stable npm releases automatically (D77); on unless a superadmin turned it off. */
  autoEnroll: boolean;
  /** Automatic updates take a release only this long after it was enrolled (0: at once). */
  soakHours: number;
}

export async function releaseSettings(env: Env): Promise<ReleaseSettings> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM platform_settings WHERE key IN (?, ?)`)
    .bind(SETTING_AUTO_ENROLL, SETTING_SOAK_HOURS)
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value;
  const soak = Number(get(SETTING_SOAK_HOURS));
  return {
    autoEnroll: get(SETTING_AUTO_ENROLL) !== 'off',
    soakHours: Number.isInteger(soak) && soak >= 0 && soak <= MAX_SOAK_HOURS ? soak : DEFAULT_SOAK_HOURS,
  };
}

export async function setReleaseSettings(env: Env, s: ReleaseSettings, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(UPSERT_SETTING).bind(SETTING_AUTO_ENROLL, s.autoEnroll ? 'on' : 'off', now),
    env.DB.prepare(UPSERT_SETTING).bind(SETTING_SOAK_HOURS, String(s.soakHours), now),
  ]);
}

// ---- offering the latest ----

/**
 * D26 step 1: record the latest version as available; the console shows it, nobody is upgraded.
 * Instances already on the latest version have nothing available (publishing an older version
 * again as the latest would otherwise leave them offered the one it replaced). Returns how many
 * instances were newly offered the latest version.
 */
export async function markAvailableVersion(env: Env): Promise<number> {
  const latest = await latestWorcaVersion(env);
  const [, res, pinned] = await env.DB.batch<{ id: string; worca_version: string; available_version: string | null }>([
    env.DB.prepare('UPDATE instances SET available_version = NULL WHERE worca_version = ?1 AND available_version IS NOT NULL').bind(latest),
    env.DB.prepare(
      `UPDATE instances SET available_version = ?1
        WHERE worca_version IS NOT NULL AND worca_version <> ?1 AND worca_version NOT LIKE '%-rc.%' AND (available_version IS NULL OR available_version <> ?1)`,
    ).bind(latest),
    env.DB.prepare(`SELECT id, worca_version, available_version FROM instances WHERE worca_version LIKE '%-rc.%'`),
  ]);
  // D80: an instance pinned to a release candidate is offered the latest only once it is newer
  // (its release, or a later one), never an older release as an upgrade.
  let offered = 0;
  for (const r of pinned?.results ?? []) {
    const want = isRc(r.worca_version) && compareVersions(latest, r.worca_version) > 0 ? latest : null;
    if (want === r.available_version) continue;
    await env.DB.prepare('UPDATE instances SET available_version = ? WHERE id = ?').bind(want, r.id).run();
    if (want) offered++;
  }
  return (res?.meta.changes ?? 0) + offered;
}

// ---- enrolling ----

export interface EnrollResult {
  latest: string;
  /** Whether `version` became the latest. */
  madeLatest: boolean;
  /** Instances newly offered the latest. */
  instancesNotified: number;
}

/**
 * Records `version` as a release. `latest: 'always'` (a superadmin's publish) makes it the latest
 * even when older; `'if_newer'` (npm) only when newer, so a backport of an older line becomes
 * deployable without replacing the latest. The previous latest may be the built-in default, never
 * recorded: it is recorded too, so it stays deployable.
 */
export async function enrollRelease(
  env: Env,
  version: string,
  opts: { by: string | null; source: 'manual' | 'npm'; latest: 'always' | 'if_newer' },
  now = Date.now(),
): Promise<EnrollResult> {
  const previous = await latestWorcaVersion(env);
  const madeLatest = opts.latest === 'always' || compareVersions(version, previous) > 0;
  const release = 'INSERT OR IGNORE INTO worca_releases (version, published_at, published_by, source) VALUES (?, ?, ?, ?)';
  await env.DB.batch([
    env.DB.prepare(release).bind(previous, null, null, 'manual'),
    env.DB.prepare(release).bind(version, now, opts.by, opts.source),
    ...(madeLatest ? [env.DB.prepare(UPSERT_SETTING).bind('worca_version', version, now)] : []),
  ]);
  const instancesNotified = madeLatest ? await markAvailableVersion(env) : 0;
  return { latest: madeLatest ? version : previous, madeLatest, instancesNotified };
}

/**
 * D80: records a release candidate. It never becomes the latest and nobody is offered it: only
 * tenant admins of orgs with release candidates on see it, and pin instances to it by hand.
 */
export async function enrollCandidate(env: Env, version: string, opts: { by: string | null; source: 'manual' | 'npm' }, now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO worca_releases (version, published_at, published_by, source) VALUES (?, ?, ?, ?)')
    .bind(version, now, opts.by, opts.source)
    .run();
}

// ---- withdrawing ----

export type WithdrawError = 'release_not_found' | 'already_withdrawn' | 'last_release';

/**
 * D77: `version` can't be deployed any more. When it was the latest, the newest release left takes
 * its place (refused when there is none). Instances that run it keep running; their org admins get
 * one email per org with the reason and what to move to.
 */
export async function withdrawRelease(
  env: Env,
  version: string,
  by: { id: string; role: string },
  reason: string,
  now = Date.now(),
): Promise<{ ok: true; latest: string; instances: number; orgsNotified: number } | { ok: false; error: WithdrawError }> {
  const row = await env.DB.prepare('SELECT withdrawn_at FROM worca_releases WHERE version = ?').bind(version).first<{ withdrawn_at: number | null }>();
  if (!row) return { ok: false, error: 'release_not_found' };
  if (row.withdrawn_at !== null) return { ok: false, error: 'already_withdrawn' };
  const previous = await latestWorcaVersion(env);
  let latest = previous;
  if (version === previous) {
    const { results } = await env.DB.prepare('SELECT version FROM worca_releases WHERE withdrawn_at IS NULL AND version <> ?').bind(version).all<{ version: string }>();
    const next = newest(results.map((r) => r.version));
    if (!next) return { ok: false, error: 'last_release' };
    latest = next;
  }
  const res = await env.DB.prepare(
    'UPDATE worca_releases SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE version = ? AND withdrawn_at IS NULL',
  )
    .bind(now, by.id, reason, version)
    .run();
  if (!res.meta.changes) return { ok: false, error: 'already_withdrawn' };
  if (latest !== previous) await env.DB.prepare(UPSERT_SETTING).bind('worca_version', latest, now).run();
  await markAvailableVersion(env);

  const { results: running } = await env.DB.prepare(
    `SELECT id, org_id, slug, display_name FROM instances WHERE worca_version = ? AND status <> 'deleting' ORDER BY org_id`,
  )
    .bind(version)
    .all<Pick<InstanceRow, 'id' | 'org_id' | 'slug' | 'display_name'>>();
  const byOrg = new Map<string, typeof running>();
  for (const r of running) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
  for (const [orgId, rows] of byOrg) {
    const mail = withdrawnMail(env, orgId, version, latest, reason, await Promise.all(rows.map(async (r) => ({
      name: await decryptDisplayName(env, r),
      url: instanceUrl(env, hostFor(env, r.slug)),
      page: `${env.APP_ORIGIN}/o/${encodeURIComponent(orgId)}/instances/${encodeURIComponent(r.id)}`,
    }))));
    await notifyOrgAdmins(env, orgId, mail.subject, mail.text);
  }
  await deps().auditPlatform(env, {
    actorId: by.id, actorRole: by.role, action: 'platform.release_withdrawn', targetType: 'release', targetId: version,
    // The reason stays on the release row: the platform log holds no free text.
    details: { latest, instances: running.length, orgs: byOrg.size },
  });
  return { ok: true, latest, instances: running.length, orgsNotified: byOrg.size };
}

/** The email to an org's admins when a release their instances run is withdrawn. */
export function withdrawnMail(
  env: Env,
  orgId: string,
  version: string,
  latest: string,
  reason: string,
  instances: { name: string; url: string; page: string }[],
): { subject: string; text: string } {
  const one = instances.length === 1;
  const list = instances.map((i) => `- ${i.name} (${i.url}): ${i.page}`).join('\n');
  const move = compareVersions(latest, version) > 0 ? `upgrade to ${latest}` : `change to ${latest}`;
  return {
    subject: `Worca ${version} was withdrawn: ${one ? `your instance ${instances[0]!.name} runs it` : `${instances.length} of your instances run it`}`,
    text:
      `The Worca platform withdrew version ${version}.\n\nReason: ${reason}\n\n` +
      `${one ? 'This instance runs it' : 'These instances run it'} and keep${one ? 's' : ''} running as before:\n${list}\n\n` +
      `Nothing is changed for you. We recommend you ${move} from the instance page when it suits you; ` +
      `the upgrade restarts Worca for about a minute.\n\nAll instances of your organization: ${env.APP_ORIGIN}/o/${encodeURIComponent(orgId)}/instances`,
  };
}

/** Undoes a withdrawal: deployable again, and the latest again when it is the newest. */
export async function restoreRelease(
  env: Env,
  version: string,
  by: { id: string; role: string },
  now = Date.now(),
): Promise<{ ok: true; latest: string } | { ok: false; error: 'release_not_found' | 'not_withdrawn' }> {
  const row = await env.DB.prepare('SELECT withdrawn_at FROM worca_releases WHERE version = ?').bind(version).first<{ withdrawn_at: number | null }>();
  if (!row) return { ok: false, error: 'release_not_found' };
  if (row.withdrawn_at === null) return { ok: false, error: 'not_withdrawn' };
  const previous = await latestWorcaVersion(env);
  const madeLatest = runsHosted(version) && compareVersions(version, previous) > 0;
  await env.DB.batch([
    env.DB.prepare('UPDATE worca_releases SET withdrawn_at = NULL, withdrawn_by = NULL, withdrawn_reason = NULL WHERE version = ?').bind(version),
    ...(madeLatest ? [env.DB.prepare(UPSERT_SETTING).bind('worca_version', version, now)] : []),
  ]);
  await markAvailableVersion(env);
  const latest = madeLatest ? version : previous;
  await deps().auditPlatform(env, {
    actorId: by.id, actorRole: by.role, action: 'platform.release_restored', targetType: 'release', targetId: version, details: { latest },
  });
  return { ok: true, latest };
}

// ---- what automatic updates install ----

/**
 * The newest release automatic updates may install now: not withdrawn, not newer than the latest,
 * and enrolled at least `soakHours` ago (a release recorded without a time counts as settled).
 * Manual upgrades aren't held back: the latest is offered at once.
 */
export async function autoUpdateTarget(env: Env, now = Date.now()): Promise<string | null> {
  const latest = await latestWorcaVersion(env);
  const { soakHours } = await releaseSettings(env);
  const settledBefore = now - soakHours * 3_600_000;
  const { results } = await env.DB.prepare('SELECT version, published_at FROM worca_releases WHERE withdrawn_at IS NULL').all<{
    version: string;
    published_at: number | null;
  }>();
  const recorded = new Map(results.map((r) => [r.version, r.published_at]));
  // The latest may be the built-in default, never recorded: it has always been there.
  if (!recorded.has(latest)) recorded.set(latest, null);
  return newest(
    [...recorded]
      .filter(([v, at]) => isSemver(v) && compareVersions(v, latest) <= 0 && (at === null || at <= settledBefore))
      .map(([v]) => v),
  );
}

// ---- enrolling from npm ----

export interface NpmCheck {
  enrolled: string[];
  held: { version: string; reason: HoldReason }[];
}

/**
 * The 5-minute cron's check (D77): stable versions of @worca/app on npm that are newer than the
 * enrollment floor and not recorded yet, oldest first, ENROLL_PER_TICK at a time. Each is enrolled
 * once its image is on GHCR and reports the same version; until then it is held (and retried,
 * except an image that reports another version: that one waits for staff). Off when a superadmin
 * turned automatic enrollment off, and on the local stack, which runs no images.
 */
export async function checkNpmReleases(env: Env, now = Date.now(), doFetch: typeof fetch = fetch): Promise<NpmCheck> {
  const out: NpmCheck = { enrolled: [], held: [] };
  if (env.LOCAL_DEV === '1' && env.RELEASE_IMAGE_CHECK === 'off') return out;
  if (!(await releaseSettings(env)).autoEnroll) return out;

  // The first check sets the floor at the latest of the day: older versions were staff's to choose.
  await env.DB.prepare('INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(SETTING_ENROLL_FLOOR, await latestWorcaVersion(env), now)
    .run();
  const floorRow = await env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(SETTING_ENROLL_FLOOR).first<{ value: string }>();
  const floor = floorRow && isSemver(floorRow.value) ? floorRow.value : MIN_HOSTED_WORCA_VERSION;

  const published = await npmVersions(doFetch);
  const stableOnNpm = new Set(published.filter(isSemver));
  // D80: release candidates too, but not those whose release is out already.
  const onNpm = published.filter(
    (v) => ((isSemver(v) && runsHosted(v)) || (rcRunsHosted(v) && !stableOnNpm.has(releaseOf(v)))) && compareVersions(v, floor) > 0,
  );
  if (!onNpm.length) return out;
  const [recordedRes, holdsRes] = await env.DB.batch<{ version: string; reason?: HoldReason }>([
    env.DB.prepare('SELECT version FROM worca_releases'),
    env.DB.prepare('SELECT version, reason FROM release_holds'),
  ]);
  const recorded = new Set((recordedRes?.results ?? []).map((r) => r.version));
  const holds = new Map((holdsRes?.results ?? []).map((r) => [r.version, r.reason]));
  const todo = onNpm
    .filter((v) => !recorded.has(v) && holds.get(v) !== 'label_mismatch')
    .sort(compareVersions)
    .slice(0, ENROLL_PER_TICK);

  for (const version of todo) {
    const image = await checkImage(version, doFetch, imageSources(env).worca);
    if (image.status === 'ok') {
      const details = isRc(version)
        ? (await enrollCandidate(env, version, { by: null, source: 'npm' }, now), { source: 'npm', rc: true })
        : await enrollRelease(env, version, { by: null, source: 'npm', latest: 'if_newer' }, now).then((r) => ({
            source: 'npm', latest: r.latest, madeLatest: r.madeLatest, instances: r.instancesNotified,
          }));
      await env.DB.prepare('DELETE FROM release_holds WHERE version = ?').bind(version).run();
      await deps().auditPlatform(env, {
        actorId: null, actorRole: 'system', action: 'platform.release_enrolled', targetType: 'release', targetId: version, details,
      });
      out.enrolled.push(version);
      continue;
    }
    const reason: HoldReason = image.status === 'missing' ? 'image_missing' : image.status === 'mismatch' ? 'label_mismatch' : 'registry_unavailable';
    const detail = image.status === 'mismatch' ? image.label ?? '' : null;
    await env.DB.prepare(
      `INSERT INTO release_holds (version, reason, detail, first_seen_at, checked_at) VALUES (?1, ?2, ?3, ?4, ?4)
        ON CONFLICT (version) DO UPDATE SET reason = ?2, detail = ?3, checked_at = ?4`,
    )
      .bind(version, reason, detail, now)
      .run();
    if (reason === 'label_mismatch' && holds.get(version) !== 'label_mismatch') {
      // Once: an image that can never finish an upgrade is the staff's to look at.
      await deps().auditPlatform(env, {
        actorId: null, actorRole: 'system', action: 'platform.release_held', targetType: 'release', targetId: version, details: { reports: detail },
      });
    }
    out.held.push({ version, reason });
  }
  return out;
}

// worca versions and the container images each one deploys.
//
// The latest version comes from platform_settings key `worca_version` (set when a release is
// enrolled from npm, D77, or published by a superadmin) and falls back to DEFAULT_WORCA_VERSION.
// A withdrawn release (D77) stays recorded but is never deployed again. Every service image of one worca version
// carries the same tag; cloudflared is pinned separately. Tenant admins start upgrades; only micro
// releases are installed automatically, while idle, where enabled (D26 as amended, auto-update.ts).
import type { Env } from '../env';
import type { ComputeRef, InstanceSpec } from '../providers/types';

export const DEFAULT_WORCA_VERSION = '1.9.0';
/**
 * The oldest worca that runs hosted: 1.9.0 verifies the platform's identity tokens
 * (WORCA_IDENTITY_ISSUER). Older images refuse to start with the variables the provisioner sets,
 * so they are never published, created, upgraded to or rolled back to.
 */
export const MIN_HOSTED_WORCA_VERSION = '1.9.0';
const SEMVER = /^\d+\.\d+\.\d+$/;
/** D80: a release candidate, x.y.z-rc.N (worca-cc docs/RELEASING.md: only `-rc.N` goes to npm's rc tag). */
const RC = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/;

/**
 * a < b, a == b, a > b as -1, 0, 1 for x.y.z versions and release candidates (D80): a candidate
 * comes before its release and after the release before it, 1.9.0 < 1.10.0-rc.1 < 1.10.0-rc.2 < 1.10.0.
 */
export function compareVersions(a: string, b: string): number {
  const [ca, ra] = splitRc(a);
  const [cb, rb] = splitRc(b);
  const pa = ca.split('.').map(Number);
  const pb = cb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  if (ra === rb) return 0;
  if (ra === null) return 1;
  if (rb === null) return -1;
  return ra < rb ? -1 : 1;
}

/** The release part and the candidate number (null for a release). */
function splitRc(v: string): [string, number | null] {
  const m = RC.exec(v);
  return m ? [m[1]!, Number(m[2])] : [v, null];
}

/** D80: a release candidate, x.y.z-rc.N. Never the latest, never installed automatically. */
export function isRc(version: unknown): version is string {
  return typeof version === 'string' && RC.test(version);
}

/** A release (x.y.z) or a release candidate: a version an instance may run and an image tag. */
export function isVersion(version: unknown): version is string {
  return isSemver(version) || isRc(version);
}

/** The release a candidate leads to: 1.10.0-rc.2 → 1.10.0 (a release is its own). */
export const releaseOf = (version: string): string => splitRc(version)[0];

/** D80: a release candidate of a version that runs hosted (MIN_HOSTED_WORCA_VERSION or newer). */
export const rcRunsHosted = (version: string): boolean => isRc(version) && compareVersions(releaseOf(version), MIN_HOSTED_WORCA_VERSION) >= 0;

/** Whether this worca version can run on the platform (MIN_HOSTED_WORCA_VERSION or newer). */
export const runsHosted = (version: string): boolean => SEMVER.test(version) && compareVersions(version, MIN_HOSTED_WORCA_VERSION) >= 0;
// worca and its credential broker ship as one public image (worca-cc docs/docker.md,
// docs/credential-broker.md "Two services from the same image"); the broker differs only by its
// start command (providers/railway.ts). A deployment can point both at a mirror or its own build
// (WORCA_IMAGE, a repository without a tag) and pin another cloudflared (CLOUDFLARED_IMAGE).
export const DEFAULT_WORCA_IMAGE = 'ghcr.io/sinishadjukic/worca';
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2026.10.3';

/** Where a deployment's instance images come from. */
export interface ImageSources {
  /** worca and broker, tagged by worca version. */
  worca: string;
  /** cloudflared with its tag. */
  cloudflared: string;
}

export function imageSources(env: Pick<Env, 'WORCA_IMAGE' | 'CLOUDFLARED_IMAGE'>): ImageSources {
  return { worca: env.WORCA_IMAGE?.trim() || DEFAULT_WORCA_IMAGE, cloudflared: env.CLOUDFLARED_IMAGE?.trim() || DEFAULT_CLOUDFLARED_IMAGE };
}

export function imagesFor(version: string, sources: ImageSources): InstanceSpec['image'] {
  return {
    worca: `${sources.worca}:${version}`,
    broker: `${sources.worca}:${version}`,
    cloudflared: sources.cloudflared,
  };
}

// ---- What an instance was deployed with (D76) ----

type ServiceKind = keyof ComputeRef['services'];

/**
 * The services a component refresh redeploys on its own. cloudflared carries no state and doesn't
 * run worca's pipelines, and the new connector proves itself by reporting its version to Cloudflare.
 * worca and the broker share the version's tag, so they only change with an upgrade.
 */
export const REFRESHABLE: readonly ServiceKind[] = ['cloudflared'];

/** The images an instance was last deployed with (instances.deployed_images, migration 0026), or null. */
export function parseDeployedImages(json: string | null): Partial<InstanceSpec['image']> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Partial<InstanceSpec['image']>) : null;
  } catch {
    return null;
  }
}

/**
 * The services whose image differs from what the instance's worca version deploys today. An
 * instance deployed before the images were recorded runs worca and the broker from its version's
 * tag (they always share it), while its cloudflared is unknown and so counts as out of date.
 * Nothing without a well-formed version.
 */
export function outdatedServices(row: { worca_version: string | null; deployed_images: string | null }, sources: ImageSources): ServiceKind[] {
  if (!isVersion(row.worca_version)) return [];
  const want = imagesFor(row.worca_version, sources);
  const inferred: Partial<InstanceSpec['image']> = { worca: want.worca, broker: want.broker };
  const have = { ...inferred, ...parseDeployedImages(row.deployed_images) };
  return (Object.keys(want) as ServiceKind[]).filter((k) => have[k] !== want[k]);
}

/** Out of date only in services a refresh can redeploy on its own (and in at least one). */
export function needsRefresh(row: { worca_version: string | null; deployed_images: string | null }, sources: ImageSources): boolean {
  const outdated = outdatedServices(row, sources);
  return outdated.length > 0 && outdated.every((k) => REFRESHABLE.includes(k));
}

/** The version cloudflared reports to Cloudflare for an image tag: `cloudflare/cloudflared:2026.10.3` → `2026.10.3`. */
export const imageTag = (image: string): string => image.slice(image.lastIndexOf(':') + 1);

export async function latestWorcaVersion(env: Env): Promise<string> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM platform_settings WHERE key = 'worca_version'`).first<{ value: string }>();
    return row && runsHosted(row.value) ? row.value : DEFAULT_WORCA_VERSION;
  } catch {
    return DEFAULT_WORCA_VERSION; // platform_settings not migrated yet
  }
}


export function isSemver(version: unknown): version is string {
  return typeof version === 'string' && SEMVER.test(version);
}

/** `to` is a newer micro release of `from`'s major.minor: 1.9.1 → 1.9.2, never 1.9 → 1.10 or a prerelease. */
export function isMicroUpdate(from: string | null, to: string): boolean {
  if (!isSemver(from) || !isSemver(to)) return false;
  const [fa, fb, fc] = from.split('.').map(Number);
  const [ta, tb, tc] = to.split('.').map(Number);
  return fa === ta && fb === tb && tc! > fc!;
}

/** `to` is a newer minor release of `from`'s major, any micro: 1.9.4 → 1.10.0 or 1.11.2, never 1.x → 2.0 or a prerelease. */
export function isMinorUpdate(from: string | null, to: string): boolean {
  if (!isSemver(from) || !isSemver(to)) return false;
  const [fa, fb] = from.split('.').map(Number);
  const [ta, tb] = to.split('.').map(Number);
  return fa === ta && tb! > fb!;
}

export interface Withdrawal {
  reason: string;
  withdrawnAt: number;
}

/** D77: the releases superadmins withdrew, by version. */
export async function withdrawnReleases(env: Env): Promise<Map<string, Withdrawal>> {
  const out = new Map<string, Withdrawal>();
  try {
    const { results } = await env.DB.prepare(`SELECT version, withdrawn_at, withdrawn_reason FROM worca_releases WHERE withdrawn_at IS NOT NULL`).all<{
      version: string;
      withdrawn_at: number;
      withdrawn_reason: string | null;
    }>();
    for (const r of results) out.set(r.version, { reason: r.withdrawn_reason ?? '', withdrawnAt: r.withdrawn_at });
  } catch {
    // not migrated yet
  }
  return out;
}

export async function isWithdrawn(env: Env, version: string): Promise<boolean> {
  try {
    return !!(await env.DB.prepare(`SELECT 1 FROM worca_releases WHERE version = ? AND withdrawn_at IS NOT NULL`).bind(version).first());
  } catch {
    return false;
  }
}

/**
 * Releases the platform has published and not withdrawn: the `worca_releases` table (migration
 * 0008), plus the legacy platform_settings `worca_released_versions` JSON array that 0008 migrates
 * and removes.
 */
async function releasedVersions(env: Env): Promise<string[]> {
  const out: string[] = [];
  try {
    const rows = await env.DB.prepare(`SELECT version FROM worca_releases WHERE withdrawn_at IS NULL`).all<{ version: string }>();
    out.push(...rows.results.map((r) => r.version).filter(isSemver));
  } catch {
    // worca_releases not migrated yet
  }
  try {
    const row = await env.DB.prepare(`SELECT value FROM platform_settings WHERE key = 'worca_released_versions'`).first<{ value: string }>();
    const list: unknown = row ? JSON.parse(row.value) : [];
    if (Array.isArray(list)) out.push(...list.filter(isSemver));
  } catch {
    // no legacy list
  }
  const withdrawn = await withdrawnReleases(env);
  return out.filter((v) => !withdrawn.has(v));
}

/**
 * Only versions the platform has published may be deployed: a tenant-chosen string must never pick
 * an arbitrary image tag. Published = the latest, the instance's recorded available version, or the
 * released-versions list; never older than MIN_HOSTED_WORCA_VERSION, and never a withdrawn one (D77).
 */
export async function isPublishedVersion(env: Env, version: string, availableVersion: string | null, opts: { rc?: boolean } = {}): Promise<boolean> {
  // D80: a release candidate only where the caller allows one, and only an enrolled one.
  if (isRc(version)) return !!opts.rc && rcRunsHosted(version) && (await isEnrolled(env, version)) && !(await isWithdrawn(env, version));
  if (!isSemver(version) || !runsHosted(version) || (await isWithdrawn(env, version))) return false;
  if (version === availableVersion || version === (await latestWorcaVersion(env))) return true;
  return (await releasedVersions(env)).includes(version);
}

export interface DeployableVersion {
  version: string;
  /** When the platform published it; null for the built-in default and releases from before P10. */
  publishedAt: number | null;
  /** D80: a release candidate. */
  rc?: boolean;
}

/** D80: a superadmin gave the org release candidates (org_settings.rc_access, migration 0031). */
export async function orgHasReleaseCandidates(env: Env, orgId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT rc_access FROM org_settings WHERE org_id = ?').bind(orgId).first<{ rc_access: number }>();
    return !!row?.rc_access;
  } catch {
    return false; // not migrated yet
  }
}

async function isEnrolled(env: Env, version: string): Promise<boolean> {
  try {
    return !!(await env.DB.prepare('SELECT 1 FROM worca_releases WHERE version = ?').bind(version).first());
  } catch {
    return false;
  }
}

/**
 * D80: the release candidates a tenant admin of an org with release candidates on may pin an
 * instance to, newest first: enrolled, not withdrawn, of a version that runs hosted and isn't out
 * yet (its release is neither recorded nor at or below the latest). Once the release is out its
 * candidates leave the list; instances pinned to one keep running it until an admin moves them.
 */
export async function releaseCandidates(env: Env): Promise<DeployableVersion[]> {
  let rows: { version: string; published_at: number | null; withdrawn_at: number | null }[];
  try {
    rows = (await env.DB.prepare('SELECT version, published_at, withdrawn_at FROM worca_releases').all<(typeof rows)[number]>()).results;
  } catch {
    return []; // worca_releases not migrated yet
  }
  const latest = await latestWorcaVersion(env);
  const released = new Set(rows.map((r) => r.version).filter(isSemver));
  return rows
    .filter((r) => r.withdrawn_at === null && rcRunsHosted(r.version) && !released.has(releaseOf(r.version)) && compareVersions(releaseOf(r.version), latest) > 0)
    .map((r) => ({ version: r.version, publishedAt: r.published_at ?? null, rc: true }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Every version a tenant admin may move an instance to, newest first: the same set
 * isPublishedVersion accepts (published releases, the latest, the instance's available version),
 * never older than MIN_HOSTED_WORCA_VERSION and never withdrawn (D77).
 */
export async function deployableVersions(
  env: Env,
  availableVersion: string | null,
  opts: { rc?: boolean } = {},
): Promise<{ latest: string; versions: DeployableVersion[] }> {
  const latest = await latestWorcaVersion(env);
  const byVersion = new Map<string, number | null>();
  try {
    const rows = await env.DB.prepare(`SELECT version, published_at FROM worca_releases WHERE withdrawn_at IS NULL`).all<{ version: string; published_at: number | null }>();
    for (const r of rows.results) byVersion.set(r.version, r.published_at ?? null);
  } catch {
    // worca_releases not migrated yet
  }
  const withdrawn = await withdrawnReleases(env);
  for (const v of [...(await releasedVersions(env)), latest, availableVersion]) {
    if (v && !byVersion.has(v)) byVersion.set(v, null);
  }
  const versions = [...byVersion]
    .filter(([v]) => runsHosted(v) && !withdrawn.has(v))
    .map(([version, publishedAt]): DeployableVersion => ({ version, publishedAt }));
  // D80: an org with release candidates on also sees the candidates of releases not out yet.
  if (opts.rc) versions.push(...(await releaseCandidates(env)));
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return { latest, versions };
}

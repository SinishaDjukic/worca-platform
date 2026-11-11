// Where worca releases come from (D77): the npm registry lists them, GHCR holds their images.
// Both are public; every call goes through the `doFetch` the caller passes, so tests stand in for
// the registries.


/** The npm package worca ships as (worca-cc release-npm-app.yml). */
export const WORCA_NPM_PACKAGE = '@worca/app';
/** The image label docker-image.yml sets from package.json's version. */
export const VERSION_LABEL = 'org.opencontainers.image.version';

type Fetch = typeof fetch;

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];

/** Every version of the package on npm (the abbreviated document: names only, about 60 kB). */
export async function npmVersions(doFetch: Fetch, pkg = WORCA_NPM_PACKAGE): Promise<string[]> {
  const res = await doFetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
  const doc = (await res.json()) as { versions?: Record<string, unknown> };
  return Object.keys(doc.versions ?? {});
}

export type ImageCheck =
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'unavailable' }
  /** The image exists but reports another version (`label`), or none (null). */
  | { status: 'mismatch'; label: string | null };

interface ManifestDoc {
  manifests?: { digest: string; mediaType?: string; platform?: { os?: string; architecture?: string } }[];
  config?: { digest?: string };
}

/**
 * Whether <repository>:<version> (the deployment's WORCA_IMAGE, images.ts) exists and reports `version` in its version label. The upgrade
 * waits for a heartbeat that reports the target version exactly (heartbeat.ts), so an image that
 * reports another one (a release candidate retagged as the release) can never finish an upgrade.
 * Through GHCR's anonymous pull-token flow: the manifest (an index: its linux/amd64 entry, which
 * the compute provider runs), then the image config with the labels.
 */
export async function checkImage(version: string, doFetch: Fetch, repository: string): Promise<ImageCheck> {
  const [registry, ...rest] = repository.split('/');
  const repo = rest.join('/');
  const base = `https://${registry}/v2/${repo}`;
  try {
    const tokenRes = await doFetch(`https://${registry}/token?scope=repository:${repo}:pull&service=${registry}`);
    if (!tokenRes.ok) return { status: 'unavailable' };
    const { token } = (await tokenRes.json()) as { token?: unknown };
    if (typeof token !== 'string' || !token) return { status: 'unavailable' };
    const auth = { authorization: `Bearer ${token}` };

    const top = await doFetch(`${base}/manifests/${encodeURIComponent(version)}`, { headers: { ...auth, accept: [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ') } });
    if (top.status === 404) return { status: 'missing' };
    if (!top.ok) return { status: 'unavailable' };
    let doc = (await top.json()) as ManifestDoc;
    if (doc.manifests) {
      const entry = doc.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
      if (!entry) return { status: 'mismatch', label: null }; // no image the provider can run
      const one = await doFetch(`${base}/manifests/${entry.digest}`, { headers: { ...auth, accept: MANIFEST_TYPES.join(', ') } });
      if (!one.ok) return { status: 'unavailable' };
      doc = (await one.json()) as ManifestDoc;
    }
    const configDigest = doc.config?.digest;
    if (!configDigest) return { status: 'unavailable' };
    const blob = await doFetch(`${base}/blobs/${configDigest}`, { headers: auth });
    if (!blob.ok) return { status: 'unavailable' };
    const config = (await blob.json()) as { config?: { Labels?: Record<string, string> | null } };
    const label = config.config?.Labels?.[VERSION_LABEL] ?? null;
    return label === version ? { status: 'ok' } : { status: 'mismatch', label };
  } catch {
    return { status: 'unavailable' };
  }
}

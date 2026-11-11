// npm and GHCR as the release code sees them (src/control/instances/registry.ts): the abbreviated
// package document, and GHCR's token, image index, per-platform manifest and config blob.
import { VERSION_LABEL } from '../../../packages/platform/src/control/instances/registry';

export interface FakeImage {
  /** The status the tag's manifest answers with instead of the image (404 = no such tag). */
  status?: number;
  /** The version label in the image config; default: the tag itself; null: no label. */
  label?: string | null;
}

export function fakeRegistry() {
  const images = new Map<string, FakeImage>();
  const state = { npm: [] as string[], npmStatus: 200 };
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    if (url.startsWith('https://registry.npmjs.org/')) {
      if (state.npmStatus !== 200) return new Response('{}', { status: state.npmStatus });
      return Response.json({ name: '@worca/app', versions: Object.fromEntries(state.npm.map((v) => [v, { version: v }])) });
    }
    if (url.startsWith('https://ghcr.io/token?')) return Response.json({ token: 'anon-token' });
    const manifest = url.match(/\/manifests\/([^/]+)$/)?.[1];
    if (manifest?.startsWith('sha256:idx-')) return Response.json({ config: { digest: `sha256:cfg-${manifest.slice(11)}` } });
    if (manifest) {
      const img = images.get(decodeURIComponent(manifest));
      if (!img) return new Response(null, { status: 404 });
      if (img.status) return new Response(null, { status: img.status });
      return Response.json({
        manifests: [
          { digest: 'sha256:attestation', platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: `sha256:idx-${manifest}`, platform: { os: 'linux', architecture: 'amd64' } },
        ],
      });
    }
    const blob = url.match(/\/blobs\/sha256:cfg-(.+)$/)?.[1];
    if (blob) {
      const img = images.get(blob);
      const label = img?.label === undefined ? blob : img.label;
      return Response.json({ config: { Labels: label === null ? {} : { [VERSION_LABEL]: label } } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { images, state, requests, fetch: doFetch };
}

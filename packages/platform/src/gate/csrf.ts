// Cross-instance request checks (security.md, "High" row): until the PSL listing (D12) every
// *.INSTANCE_DOMAIN host is same-site, so SameSite cookies don't stop instance A from driving B.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isUnsafeMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

/** This host's origin as the browser sees it, port included (local dev runs on :8798). */
export function hostOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${request.headers.get('host') ?? url.host}`;
}

/**
 * Sec-Fetch-Site must be same-origin; when absent, Origin must equal this host's origin. An Origin
 * that names another origin is refused even next to a same-origin Sec-Fetch-Site: browsers never
 * send that pair, so it only comes from something forging headers.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== hostOrigin(request)) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  return origin !== null;
}

/** Page loads get redirects and HTML; everything else gets JSON (W6). */
export function isNavigation(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode !== null) return mode === 'navigate';
  return request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
}

// Forwarding to the instance: through its own proxied hostname in production (D51), to
// HostEntry.upstream (the stub server) in local development.
import type { HostEntry } from '../shared/contracts';
import { upstreamTimeouts } from './config';
import { isNavigation, isWebSocketUpgrade } from './csrf';
import type { Env } from './env';
import { filterSetCookies, upstreamHeaders } from './headers';
import { jsonResponse, unresponsivePage } from './pages';
import { siteOf } from '../shared/site';

type FetchFn = (request: Request) => Promise<Response>;

// Resolved at call time so tests can intercept outbound fetches with a spy on globalThis.fetch.
let upstreamFetch: FetchFn = (request) => fetch(request);

/** Tests only: replace the outbound fetch. Pass null to restore the default. */
export function setUpstreamFetch(fn: FetchFn | null): void {
  upstreamFetch = fn ?? ((request) => fetch(request));
}

/**
 * Cloudflare's own answer when the instance's tunnel has no connector (error 1033). worca never
 * sends it, so it always means the instance can't be reached.
 */
const TUNNEL_DOWN_STATUS = 530;

const TIMEOUT = Symbol('timeout');

export async function forward(request: Request, host: string, entry: HostEntry | null, token: string, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const target = entry?.upstream ? new URL(url.pathname + url.search, entry.upstream) : url;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const nav = isNavigation(request);
  const ws = isWebSocketUpgrade(request);
  const limits = upstreamTimeouts(env);
  const limitMs = (nav || ws ? limits.page : limits.other) * 1000;

  // Only the wait for the response headers is bounded: the timer is cleared as soon as they
  // arrive, so a streamed body, a long download or an upgraded WebSocket runs as long as it needs.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), limitMs);
  });
  let res: Response | typeof TIMEOUT;
  try {
    res = await Promise.race([
      upstreamFetch(
        new Request(target, {
          method: request.method,
          headers: upstreamHeaders(request.headers, host, token),
          body: hasBody ? request.body : null,
          redirect: 'manual',
          signal: controller.signal,
        }),
      ),
      timedOut,
    ]);
  } catch (err) {
    console.error('upstream unreachable', host, err);
    return unanswered(nav, host, url, env, 'unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (res === TIMEOUT) {
    controller.abort(); // frees the subrequest; nothing was handed to the client yet
    console.warn('upstream timeout', host, `${limitMs} ms`, request.method, url.pathname);
    return unanswered(nav, host, url, env, 'timeout');
  }
  // WebSocket passthrough: the upgrade response is returned untouched.
  if (res.webSocket || res.status === 101) return res;
  if (res.status === TUNNEL_DOWN_STATUS) {
    await res.body?.cancel();
    return unanswered(nav, host, url, env, 'unreachable');
  }
  const out = new Response(res.body, res);
  filterSetCookies(out.headers);
  return out;
}

/** The instance didn't answer: the branded page for a page load, JSON for everything else. */
function unanswered(nav: boolean, host: string, url: URL, env: Env, why: 'timeout' | 'unreachable'): Response {
  const status = why === 'timeout' ? 504 : 502;
  if (nav) return unresponsivePage(siteOf(env), { host, path: url.pathname + url.search, appOrigin: env.APP_ORIGIN, status });
  return jsonResponse(status, { error: 'instance_unresponsive', reason: why }, { headers: { 'retry-after': '10' } });
}

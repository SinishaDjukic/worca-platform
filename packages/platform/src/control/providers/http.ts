// HTTP helpers every provider can use: a fetch with a small retry on 429, and the options tests
// inject so backoff and polling don't wait.

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  /** Injected in tests so 429 backoff and the stop confirmation don't wait. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** stop(): how often and how long to look for the provider's confirmation. */
  stopPollMs?: number;
  stopTimeoutMs?: number;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Delay before retry `attempt` (0-based): Retry-After when sent, else exponential from 1 s. */
export function retryDelayMs(res: Response, attempt: number): number {
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 30_000);
  return 1000 * 2 ** attempt;
}

/** fetch with a small retry on 429. */
export async function fetchWithRetry(fetchImpl: Fetch, url: string, init: RequestInit, opts: ProviderOptions): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    await sleep(retryDelayMs(res, attempt));
  }
}

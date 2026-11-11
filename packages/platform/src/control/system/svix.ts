// Svix webhook signature verification (Resend signs its webhooks with Svix):
// docs.svix.com/receiving/verifying-payloads/how-manual.
// signed content = `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256 with the base64 part of
// the `whsec_...` secret; `svix-signature` is a space-separated list of `v1,<base64>`.

/** Svix's default tolerance, both directions. */
export const SVIX_TOLERANCE_S = 5 * 60;

export type SvixResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' | 'bad_secret' };

const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function verifySvix(
  secret: string,
  headers: { id: string | null | undefined; timestamp: string | null | undefined; signature: string | null | undefined },
  rawBody: string,
  nowMs = Date.now(),
): Promise<SvixResult> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  const ts = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - ts) > SVIX_TOLERANCE_S) return { ok: false, reason: 'stale' };

  let key: CryptoKey;
  try {
    const raw = fromB64(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
    key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }
  const data = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromB64(sig);
    } catch {
      continue;
    }
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, bytes, data)) return { ok: true };
  }
  return { ok: false, reason: 'bad_signature' };
}

/** Signs like Svix does; used by the tests. */
export async function signSvix(secret: string, id: string, timestamp: number, rawBody: string): Promise<string> {
  const raw = fromB64(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

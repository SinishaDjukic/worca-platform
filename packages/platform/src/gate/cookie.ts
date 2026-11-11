// The gate's own cookies (D44). Both are AES-256-GCM sealed with GATE_COOKIE_KEY and bound to the
// host through the additional data, so a cookie for one instance is useless on another.

export const SESSION_COOKIE = '__Host-gate';
export const STATE_COOKIE = '__Host-gate-state';
export const STATE_SECONDS = 600;

export interface GateCookie {
  v: 1;
  sid: string;
  inst: string;
  uid: string;
  passExp: number; // unix seconds; 0 = ask the gate object on the next request
  token: string;
  tokenExp: number; // unix seconds
}

export interface StateCookie {
  v: 1;
  state: string;
  ret: string; // return path
  exp: number; // unix seconds
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error('GATE_COOKIE_KEY must be 32 bytes of base64');
    key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(secret, key);
  }
  return key;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function randomId(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function seal(secret: string, purpose: string, host: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${purpose}|${host}`);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await importKey(secret), plain),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

async function open(secret: string, purpose: string, host: string, sealed: string): Promise<unknown> {
  try {
    const bytes = fromB64url(sealed);
    if (bytes.length < 13) return null;
    const aad = new TextEncoder().encode(`${purpose}|${host}`);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad },
      await importKey(secret),
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null; // tampered, wrong host, or old key: treated as no cookie
  }
}

export function sealSession(secret: string, host: string, c: GateCookie): Promise<string> {
  return seal(secret, 'gate', host, c);
}

export async function openSession(secret: string, host: string, sealed: string): Promise<GateCookie | null> {
  const c = (await open(secret, 'gate', host, sealed)) as GateCookie | null;
  if (!c || c.v !== 1 || typeof c.sid !== 'string' || typeof c.token !== 'string') return null;
  return c;
}

export function sealState(secret: string, host: string, s: StateCookie): Promise<string> {
  return seal(secret, 'state', host, s);
}

export async function openState(secret: string, host: string, sealed: string, now: number): Promise<StateCookie | null> {
  const s = (await open(secret, 'state', host, sealed)) as StateCookie | null;
  if (!s || s.v !== 1 || typeof s.state !== 'string' || s.exp < now) return null;
  return s;
}

/** `__Host-` cookies: Secure, Path=/, no Domain (D44, security.md). */
export function setCookieHeader(name: string, value: string, maxAge?: number): string {
  const age = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax${age}`;
}

export function clearCookieHeader(name: string): string {
  return setCookieHeader(name, '', 0);
}

/** Parses a Cookie header into name/value pairs, keeping order and duplicates. */
export function parseCookies(header: string | null): Array<[string, string]> {
  if (!header) return [];
  const out: Array<[string, string]> = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

export function getCookie(header: string | null, name: string): string | null {
  return parseCookies(header).find(([n]) => n === name)?.[1] ?? null;
}

/** Only same-host relative paths, so the callback can't become an open redirect. */
export function safeReturnPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\x00-\x1f]/.test(path)) return '/';
  if (path.startsWith('/.gate/')) return '/';
  return path;
}

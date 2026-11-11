// Key hierarchy and field encryption (security.md "Application-level encryption", D36-D38).
//
//   master key (env.MASTER_KEY; env.MASTER_KEY_PREVIOUS during a master rotation)
//     └── data key per org / per user: random 32 bytes, stored wrapped in data_keys
//   blind-index key (env.BLIND_INDEX_KEY), separate from the master key
//
// Formats
//   wrapped data key:  m1.<iv>.<ct>               AAD: data_key|<type>:<id>|<version>
//   field ciphertext:  e1.<keyVersion>.<iv>.<ct>  AAD: <table>|<column>|<rowId>|<type>:<id>
// (base64url parts). data_keys.master_id names the master key that wrapped a row, as a
// fingerprint of that key (masterKeyId); NULL on rows from before migration 0011, which are tried
// against MASTER_KEY, then MASTER_KEY_PREVIOUS. A master rotation re-wraps only the data keys
// (D37, rewrapDataKeys); the data-key version lets old rows decrypt after an org key rotation
// until keys-jobs.ts has re-encrypted them (D38).
//
// Nothing here ever logs or returns key material: errors name owners, versions and master key
// fingerprints only.

import type { Env } from './env';
import { KeyDestroyedError, type FieldContext, type KeyOwner, type KeyRing } from './keys-api';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  decodeKey32,
  fromBase64Url,
  fromUtf8,
  hmacSha256Hex,
  importAesKey,
  importHmacKey,
  randomBytes,
  toBase64Url,
  utf8,
} from './crypto';
import { startOrgReencryption } from './keys-jobs';

export { KeyDestroyedError } from './keys-api';

const WRAP_FORMAT = 'm1';
const FIELD_PREFIX = 'e1';
const CIPHERTEXT_RE = /^e1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MASTER_ID_LABEL = 'worca-run master key id v1';
/** HKDF info for the fingerprint key: the master key itself only ever wraps data keys. */
const MASTER_ID_HKDF_INFO = 'worca-run master-id v1';

/** A data key is wrapped under a master key that isn't configured (MASTER_KEY / _PREVIOUS). */
export class MasterKeyUnavailableError extends Error {
  constructor(owner: KeyOwner, version: number, masterId: string | null) {
    super(
      masterId
        ? `data key ${version} of ${ownerKey(owner)} is wrapped under master key ${masterId}, which is not configured`
        : `data key ${version} of ${ownerKey(owner)} unwraps under neither MASTER_KEY nor MASTER_KEY_PREVIOUS`,
    );
    this.name = 'MasterKeyUnavailableError';
  }
}

// Per-isolate caches. Entries expire so a key destroyed or rotated from another isolate stops
// being used here within CACHE_TTL_MS; destroyKey in this isolate clears them at once.
export const CACHE_TTL_MS = 60_000;
// Only settled values are cached, never a pending load: a promise whose D1 I/O belongs to one
// request can't be awaited from another (workerd leaves the second one hanging when the first ends
// or is canceled), which made about one signed-in request in four hang until the client gave up.
type Cached<T> = { value: T; at: number };
const secretCache = new Map<string, Promise<CryptoKey>>();
const masterIdCache = new Map<string, Promise<string>>();
const legacyMasterIdCache = new Map<string, Promise<string>>();
const dataKeyCache = new Map<string, Cached<CryptoKey>>();
const currentVersionCache = new Map<string, Cached<number>>();

const ownerKey = (o: KeyOwner) => `${o.type}:${o.id}`;
const fresh = <T>(c: Cached<T> | undefined): c is Cached<T> => !!c && Date.now() - c.at < CACHE_TTL_MS;

function cachedSecret(name: string, b64: string, importer: (raw: Uint8Array) => Promise<CryptoKey>) {
  const id = `${name}:${b64}`;
  let p = secretCache.get(id);
  if (!p) {
    p = importer(decodeKey32(b64, name));
    secretCache.set(id, p);
    p.catch(() => secretCache.delete(id));
  }
  return p;
}

function memo(cache: Map<string, Promise<string>>, id: string, compute: () => Promise<string>): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = compute();
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

/** HMAC key for fingerprints, HKDF-SHA256(master, salt = none, info = MASTER_ID_HKDF_INFO). */
async function fingerprintKey(raw: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(MASTER_ID_HKDF_INFO) as BufferSource },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/**
 * The master key's id: 'k' + 16 hex of HMAC-SHA256(K_id, label), K_id derived from the master by
 * HKDF (domain separation: the raw master key is used for AES-GCM wrapping only). Identifies the
 * key without revealing it, so it can sit next to every row it wrapped.
 */
function masterIdOf(name: string, b64: string): Promise<string> {
  return memo(masterIdCache, `${name}:${b64}`, async () => 'k' + (await hmacSha256Hex(await fingerprintKey(decodeKey32(b64, name)), MASTER_ID_LABEL)).slice(0, 16));
}

/**
 * The id as first written (local dev only, before HKDF): HMAC keyed with the raw master key.
 * Only recognised when unwrapping; a master rotation (rewrapDataKeys) rewrites such rows.
 */
function legacyMasterIdOf(name: string, b64: string): Promise<string> {
  return memo(legacyMasterIdCache, `${name}:${b64}`, async () => 'k' + (await hmacSha256Hex(await importHmacKey(decodeKey32(b64, name)), MASTER_ID_LABEL)).slice(0, 16));
}

/** Id of the current master key (MASTER_KEY). */
export function masterKeyId(env: Env): Promise<string> {
  return masterIdOf('MASTER_KEY', env.MASTER_KEY);
}

// Bumped by forgetOwner, so a load that started before a key was destroyed or rotated can't put
// the old value back once it finishes.
const ownerGeneration = new Map<string, number>();

async function remember<T>(cache: Map<string, Cached<T>>, id: string, owner: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(id);
  if (fresh(hit)) return hit.value;
  const gen = ownerGeneration.get(owner) ?? 0;
  const value = await load();
  if ((ownerGeneration.get(owner) ?? 0) === gen) cache.set(id, { value, at: Date.now() });
  return value;
}

function forgetOwner(owner: KeyOwner) {
  ownerGeneration.set(ownerKey(owner), (ownerGeneration.get(ownerKey(owner)) ?? 0) + 1);
  const prefix = `${ownerKey(owner)}:`;
  for (const k of dataKeyCache.keys()) if (k.startsWith(prefix)) dataKeyCache.delete(k);
  currentVersionCache.delete(ownerKey(owner));
}

const wrapAad = (owner: KeyOwner, version: number) => `data_key|${ownerKey(owner)}|${version}`;
const fieldAad = (ctx: FieldContext) => `${ctx.table}|${ctx.column}|${ctx.rowId}|${ownerKey(ctx.owner)}`;

interface KeyRow {
  version: number;
  wrapped: string | null;
  destroyed_at: number | null;
  master_id: string | null;
}

interface Master {
  id: string;
  /** The pre-HKDF fingerprint of the same key; rows may still carry it. */
  legacyId: string;
  key: Promise<CryptoKey>;
}

class D1KeyRing implements KeyRing {
  constructor(private readonly env: Env) {}

  private async current(): Promise<Master> {
    return {
      id: await masterKeyId(this.env),
      legacyId: await legacyMasterIdOf('MASTER_KEY', this.env.MASTER_KEY),
      key: cachedSecret('MASTER_KEY', this.env.MASTER_KEY, (raw) => importAesKey(raw)),
    };
  }

  private async previous(): Promise<Master | null> {
    const b64 = this.env.MASTER_KEY_PREVIOUS;
    if (!b64) return null;
    return {
      id: await masterIdOf('MASTER_KEY_PREVIOUS', b64),
      legacyId: await legacyMasterIdOf('MASTER_KEY_PREVIOUS', b64),
      key: cachedSecret('MASTER_KEY_PREVIOUS', b64, (raw) => importAesKey(raw)),
    };
  }

  private blindKey() {
    return cachedSecret('BLIND_INDEX_KEY', this.env.BLIND_INDEX_KEY, importHmacKey);
  }

  /** Wraps under the current master key; returns the stored form and that master's id. */
  async wrap(owner: KeyOwner, version: number, raw: Uint8Array): Promise<{ wrapped: string; masterId: string }> {
    const m = await this.current();
    const { iv, ct } = await aesGcmEncrypt(await m.key, raw, wrapAad(owner, version));
    return { wrapped: `${WRAP_FORMAT}.${toBase64Url(iv)}.${toBase64Url(ct)}`, masterId: m.id };
  }

  /** The raw data key. Uses the master the row names; for an unnamed (pre-0011) row, either. */
  async unwrapRaw(owner: KeyOwner, version: number, wrapped: string, masterId: string | null): Promise<Uint8Array> {
    const [format, iv, ct, extra] = wrapped.split('.');
    if (format !== WRAP_FORMAT || !iv || !ct || extra !== undefined) {
      throw new Error(`unknown wrap format for data key ${version} of ${ownerKey(owner)}`);
    }
    const sealed = { iv: fromBase64Url(iv), ct: fromBase64Url(ct) };
    const candidates = [await this.current(), await this.previous()].filter((m): m is Master => m !== null);
    // A named row uses that master; a legacy fingerprint (pre-HKDF) names the same key too.
    const usable = masterId ? candidates.filter((m) => m.id === masterId || m.legacyId === masterId).slice(0, 1) : candidates;
    if (usable.length === 0) throw new MasterKeyUnavailableError(owner, version, masterId);
    for (const m of usable) {
      try {
        return await aesGcmDecrypt(await m.key, sealed, wrapAad(owner, version));
      } catch {
        // Wrong master (legacy row) or tampering: try the next, then fail without detail.
      }
    }
    if (masterId) throw new Error(`cannot unwrap data key ${version} of ${ownerKey(owner)}`);
    throw new MasterKeyUnavailableError(owner, version, null);
  }

  private async unwrap(owner: KeyOwner, version: number, wrapped: string, masterId: string | null): Promise<CryptoKey> {
    const raw = await this.unwrapRaw(owner, version, wrapped, masterId);
    try {
      return await importAesKey(raw);
    } finally {
      raw.fill(0);
    }
  }

  private rows(owner: KeyOwner): Promise<KeyRow[]> {
    return this.env.DB.prepare(
      'SELECT version, wrapped, destroyed_at, master_id FROM data_keys WHERE owner_type = ? AND owner_id = ? ORDER BY version',
    )
      .bind(owner.type, owner.id)
      .all<KeyRow>()
      .then((r) => r.results);
  }

  private async insertKey(owner: KeyOwner, version: number, rotation?: { at: number; by: string | null }): Promise<boolean> {
    const raw = randomBytes(32);
    let w: { wrapped: string; masterId: string };
    try {
      w = await this.wrap(owner, version, raw);
    } finally {
      raw.fill(0);
    }
    const now = Date.now();
    const res = await this.env.DB.prepare(
      `INSERT INTO data_keys (id, owner_type, owner_id, version, wrapped, master_id, created_at, rotated_at, rotated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_type, owner_id, version) DO NOTHING`,
    )
      .bind(crypto.randomUUID(), owner.type, owner.id, version, w.wrapped, w.masterId, now, rotation?.at ?? null, rotation?.by ?? null)
      .run();
    return res.meta.changes > 0;
  }

  async ensureKey(owner: KeyOwner): Promise<void> {
    const rows = await this.rows(owner);
    // A destroyed owner never gets a fresh key: that would quietly undo the erasure.
    if (rows.length > 0) return;
    await this.insertKey(owner, 1);
  }

  /** Version new ciphertexts use: the newest live one, created on first use. */
  private currentVersion(owner: KeyOwner): Promise<number> {
    return remember(currentVersionCache, ownerKey(owner), ownerKey(owner), async () => {
      let rows = await this.rows(owner);
      if (rows.length === 0) {
        await this.insertKey(owner, 1);
        rows = await this.rows(owner);
      }
      const latest = rows.at(-1);
      if (!latest || latest.destroyed_at !== null || latest.wrapped === null) throw new KeyDestroyedError(owner);
      return latest.version;
    });
  }

  private dataKey(owner: KeyOwner, version: number): Promise<CryptoKey> {
    return remember(dataKeyCache, `${ownerKey(owner)}:${version}`, ownerKey(owner), async () => {
      const row = await this.env.DB.prepare(
        'SELECT version, wrapped, destroyed_at, master_id FROM data_keys WHERE owner_type = ? AND owner_id = ? AND version = ?',
      )
        .bind(owner.type, owner.id, version)
        .first<KeyRow>();
      if (!row) throw new Error(`no data key ${version} for ${ownerKey(owner)}`);
      if (row.destroyed_at !== null || row.wrapped === null) throw new KeyDestroyedError(owner);
      return this.unwrap(owner, version, row.wrapped, row.master_id);
    });
  }

  /** Encrypts under a given key version (the re-encryption job's target, not the cached current). */
  async encryptAt(ctx: FieldContext, plaintext: string, version: number): Promise<string> {
    const key = await this.dataKey(ctx.owner, version);
    const { iv, ct } = await aesGcmEncrypt(key, utf8(plaintext), fieldAad(ctx));
    return `${FIELD_PREFIX}.${version}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
  }

  async encrypt(ctx: FieldContext, plaintext: string): Promise<string> {
    return this.encryptAt(ctx, plaintext, await this.currentVersion(ctx.owner));
  }

  async decrypt(ctx: FieldContext, ciphertext: string): Promise<string> {
    if (!this.isCiphertext(ciphertext)) throw new Error(`${ctx.table}.${ctx.column} is not a ciphertext`);
    const [, v, iv, ct] = ciphertext.split('.') as [string, string, string, string];
    const key = await this.dataKey(ctx.owner, Number(v));
    try {
      return fromUtf8(await aesGcmDecrypt(key, { iv: fromBase64Url(iv), ct: fromBase64Url(ct) }, fieldAad(ctx)));
    } catch {
      // Wrong row, column or owner (AAD), or tampering: never say which.
      throw new Error(`cannot decrypt ${ctx.table}.${ctx.column} of ${ctx.rowId}`);
    }
  }

  isCiphertext(value: unknown): boolean {
    return typeof value === 'string' && CIPHERTEXT_RE.test(value);
  }

  async blindIndex(value: string): Promise<string> {
    return hmacSha256Hex(await this.blindKey(), value);
  }

  emailIndex(email: string): Promise<string> {
    return this.blindIndex(email.trim().toLowerCase());
  }

  async destroyKey(owner: KeyOwner): Promise<void> {
    forgetOwner(owner);
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE data_keys SET wrapped = NULL, destroyed_at = COALESCE(destroyed_at, ?)
       WHERE owner_type = ? AND owner_id = ?`,
    )
      .bind(now, owner.type, owner.id)
      .run();
    // Record the erasure even for an owner that never had a key, so ensureKey won't create one.
    await this.env.DB.prepare(
      `INSERT INTO data_keys (id, owner_type, owner_id, version, wrapped, created_at, destroyed_at)
       SELECT ?, ?, ?, 1, NULL, ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM data_keys WHERE owner_type = ? AND owner_id = ?)`,
    )
      .bind(crypto.randomUUID(), owner.type, owner.id, now, now, owner.type, owner.id)
      .run();
    forgetOwner(owner);
  }

  /**
   * D38: a new version of the org's key, then a job that re-encrypts the org's rows to it and
   * destroys the older versions once none references them (keys-jobs.ts).
   */
  async rotateOrgKey(orgId: string, opts: { by?: string | null } = {}): Promise<number> {
    const owner: KeyOwner = { type: 'org', id: orgId };
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = (await this.rows(owner)).at(-1);
      if (latest && (latest.destroyed_at !== null || latest.wrapped === null)) throw new KeyDestroyedError(owner);
      const next = (latest?.version ?? 0) + 1;
      const at = Date.now();
      if (await this.insertKey(owner, next, { at, by: opts.by ?? null })) {
        forgetOwner(owner);
        await startOrgReencryption(this.env, orgId, next, at);
        return next;
      }
    }
    throw new Error(`could not rotate the key of org ${orgId}: concurrent rotations`);
  }
}

export function getKeyRing(env: Env): KeyRing {
  return new D1KeyRing(env);
}

// ---- rotation support (keys-jobs.ts, keys-routes.ts) -------------------------------------------

/** Re-encrypts one ciphertext under `version` of its owner's key (same field context). */
export async function reencryptField(env: Env, ctx: FieldContext, ciphertext: string, version: number): Promise<string> {
  const ring = new D1KeyRing(env);
  return ring.encryptAt(ctx, await ring.decrypt(ctx, ciphertext), version);
}

/** Version of a ciphertext's data key, or null when the value isn't one of ours. */
export function ciphertextVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !CIPHERTEXT_RE.test(value)) return null;
  return Number(value.split('.')[1]);
}

/** Drops this isolate's cached keys and version of an owner (after destroying old versions). */
export function forgetKeyCache(owner: KeyOwner): void {
  forgetOwner(owner);
}

export interface RewrapResult {
  rewrapped: number;
  /** Rows that could not be unwrapped with any configured master key (left as they were). */
  failed: number;
  /** True when this call saw no more rows to look at past its cursor. */
  exhausted: boolean;
  /** Last data_keys.id looked at; pass back to continue past failed rows. */
  cursor: string | null;
}

/**
 * D37: re-wraps up to `limit` live data keys that aren't under the current master key. Only the
 * wrapped keys change; ciphertexts don't. Each row is updated only if it is unchanged since it was
 * read, so a concurrent destroyKey (wrapped = NULL) is never undone.
 */
export async function rewrapDataKeys(env: Env, opts: { limit?: number; after?: string | null } = {}): Promise<RewrapResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const ring = new D1KeyRing(env);
  const currentId = await masterKeyId(env);
  const rows = await env.DB.prepare(
    `SELECT id, owner_type, owner_id, version, wrapped, master_id FROM data_keys
      WHERE wrapped IS NOT NULL AND (master_id IS NULL OR master_id <> ?) AND id > ?
      ORDER BY id LIMIT ?`,
  )
    .bind(currentId, opts.after ?? '', limit)
    .all<{ id: string; owner_type: KeyOwner['type']; owner_id: string; version: number; wrapped: string; master_id: string | null }>();
  const updates: D1PreparedStatement[] = [];
  let failed = 0;
  for (const r of rows.results) {
    const owner = { type: r.owner_type, id: r.owner_id } as KeyOwner;
    let raw: Uint8Array | null = null;
    try {
      raw = await ring.unwrapRaw(owner, r.version, r.wrapped, r.master_id);
      const w = await ring.wrap(owner, r.version, raw);
      updates.push(
        env.DB.prepare('UPDATE data_keys SET wrapped = ?, master_id = ? WHERE id = ? AND wrapped = ? AND master_id IS ?').bind(
          w.wrapped,
          w.masterId,
          r.id,
          r.wrapped,
          r.master_id,
        ),
      );
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ at: 'keys.rewrap', owner: ownerKey(owner), version: r.version, error: (err as Error).name }));
    } finally {
      raw?.fill(0);
    }
  }
  let rewrapped = 0;
  if (updates.length > 0) {
    for (const res of await env.DB.batch(updates)) rewrapped += res.meta.changes ?? 0;
  }
  return { rewrapped, failed, exhausted: rows.results.length < limit, cursor: rows.results.at(-1)?.id ?? opts.after ?? null };
}

export interface MasterKeyStatus {
  masterId: string;
  previousMasterId: string | null;
  /** Live (not destroyed) data keys. */
  total: number;
  /** Of those, wrapped under the current master key. */
  done: number;
  status: 'done' | 'pending';
}

export async function masterKeyStatus(env: Env): Promise<MasterKeyStatus> {
  const masterId = await masterKeyId(env);
  const previousMasterId = env.MASTER_KEY_PREVIOUS ? await masterIdOf('MASTER_KEY_PREVIOUS', env.MASTER_KEY_PREVIOUS) : null;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN master_id = ? THEN 1 ELSE 0 END), 0) AS done
       FROM data_keys WHERE wrapped IS NOT NULL`,
  )
    .bind(masterId)
    .first<{ total: number; done: number }>();
  const total = row?.total ?? 0;
  const done = row?.done ?? 0;
  return { masterId, previousMasterId, total, done, status: done >= total ? 'done' : 'pending' };
}

/** Tests only: drop the per-isolate caches. */
export function _clearKeyCaches(): void {
  dataKeyCache.clear();
  currentVersionCache.clear();
  ownerGeneration.clear();
}

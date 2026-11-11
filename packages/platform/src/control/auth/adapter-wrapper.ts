// The Better Auth adapter wrapper (security.md "The Better Auth adapter", D36, D49, D54).
//
// Sits outside Better Auth's adapter factory, so it sees model keys, logical field names and
// structured `where` clauses. It encrypts tenant data on write, decrypts on read (joined rows
// included), keeps blind indexes next to encrypted lookup fields, and stores session tokens
// only as hashes.

import type { DBAdapter, DBTransactionAdapter, JoinOption, Where } from 'better-auth/adapters';
import { sha256Hex, type KeyOwner, type KeyRing } from '../keys-api';
import { hmacSha256Hex, importHmacKey, timingSafeEqual, utf8 } from '../crypto';

type Row = Record<string, unknown>;
type Adapter = DBAdapter | DBTransactionAdapter;

interface ModelSpec {
  table: string;
  owner: { type: KeyOwner['type']; field: string };
  /** SSO providers may belong to a user instead of an org. */
  fallbackOwner?: { type: KeyOwner['type']; field: string };
  encrypted: readonly string[];
  /** Encrypted field -> its blind-index column (not known to Better Auth). */
  indexed?: Readonly<Record<string, string>>;
}

// Field contexts: docs/internal-apis.md, plus D49 and D54.
export const ENCRYPTED_MODELS: Readonly<Record<string, ModelSpec>> = {
  user: { table: 'user', owner: { type: 'user', field: 'id' }, encrypted: ['email', 'name'], indexed: { email: 'emailIndex' } },
  session: { table: 'session', owner: { type: 'user', field: 'userId' }, encrypted: ['ipAddress', 'userAgent'] },
  account: {
    table: 'account',
    owner: { type: 'user', field: 'userId' },
    encrypted: ['accessToken', 'refreshToken', 'idToken'],
  },
  organization: { table: 'organization', owner: { type: 'org', field: 'id' }, encrypted: ['name'] },
  team: { table: 'team', owner: { type: 'org', field: 'organizationId' }, encrypted: ['name'] },
  invitation: {
    table: 'invitation',
    owner: { type: 'org', field: 'organizationId' },
    encrypted: ['email'],
    indexed: { email: 'emailIndex' },
  },
  ssoProvider: {
    table: 'ssoProvider',
    owner: { type: 'org', field: 'organizationId' },
    fallbackOwner: { type: 'user', field: 'userId' },
    encrypted: ['domain', 'oidcConfig', 'samlConfig'],
    indexed: { domain: 'domainIndex' },
  },
};

/** Prefix of stored session-token hashes (D49). */
export const TOKEN_HASH_PREFIX = 'h1.';
/** Prefix of the session handles handed back in place of a token we don't know (see below). */
export const SESSION_HANDLE_PREFIX = 'r1.';
const HANDLE_TTL_S = 15 * 60;
// Stands in for "no row": an `in` list must not be empty, and no id looks like this.
const NO_MATCH = '\u0000no-match';

/**
 * Every caller-supplied token is hashed, whatever it looks like: a stored hash taken from a
 * leaked export must never work as a token.
 */
export async function hashSessionToken(token: string): Promise<string> {
  return TOKEN_HASH_PREFIX + (await sha256Hex(token));
}

export class EncryptedFieldQueryError extends Error {
  constructor(model: string, field: string, what: string) {
    super(`${model}.${field} is encrypted: ${what} is not supported; only eq/in on blind-indexed fields (D54)`);
    this.name = 'EncryptedFieldQueryError';
  }
}

export interface WrapperDeps {
  ring: KeyRing;
  db: D1Database;
  /** Signs session handles; never stored in D1 (createDatabase uses BETTER_AUTH_SECRET). */
  handleSecret: string;
}

// Session rows read by anything but their raw token (listSessions) can't return the raw token,
// which we don't keep, and must not return the stored hash. They carry a handle instead:
//   r1.<sessionId>.<expiresAtSeconds>.<hmac(secret, "session-handle|id|exp|storedHash")>
// It is valid for HANDLE_TTL_S, only for that session, only while its token is unchanged, and
// can't be made from a database export. Better Auth passes it back on revokeSession, which
// finds and deletes by it. It is no more powerful than the raw token listSessions would
// otherwise return to the session's own user.
const handleKeys = new Map<string, Promise<CryptoKey>>();
function handleKey(secret: string) {
  let k = handleKeys.get(secret);
  if (!k) {
    k = importHmacKey(utf8(`session-handle-key|${secret}`));
    handleKeys.set(secret, k);
  }
  return k;
}
async function handleMac(secret: string, id: string, exp: number, storedHash: string) {
  return hmacSha256Hex(await handleKey(secret), `session-handle|${id}|${exp}|${storedHash}`);
}
export async function makeSessionHandle(secret: string, id: string, storedHash: string, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + HANDLE_TTL_S;
  return `${SESSION_HANDLE_PREFIX}${id}.${exp}.${await handleMac(secret, id, exp, storedHash)}`;
}

/** Per-call memory of raw session tokens seen in a where clause: hash -> raw. */
type TokenMap = Map<string, string>;

export function wrapAdapter<A extends Adapter>(base: A, deps: WrapperDeps): A {
  const { ring, db, handleSecret } = deps;
  if (!handleSecret) throw new Error('the adapter wrapper needs a secret for session handles');
  const spec = (model: string) => ENCRYPTED_MODELS[model];

  const blindIndex = (value: string) => ring.blindIndex(value.trim().toLowerCase());

  function ownerOf(model: string, row: Row): KeyOwner {
    const s = spec(model)!;
    for (const o of [s.owner, s.fallbackOwner]) {
      const id = o && row[o.field];
      if (o && typeof id === 'string' && id) return { type: o.type, id };
    }
    throw new Error(`cannot resolve the key owner of ${model} ${String(row.id)}`);
  }

  function ownerFields(model: string): string[] {
    const s = spec(model);
    if (!s) return [];
    return ['id', s.owner.field, ...(s.fallbackOwner ? [s.fallbackOwner.field] : [])];
  }

  function touchesProtected(model: string, data: Row): boolean {
    const s = spec(model);
    if (model === 'session' && 'token' in data) return true;
    return !!s && s.encrypted.some((f) => f in data);
  }

  // ---------- where clauses ----------

  async function idsByIndex(table: string, column: string, indexes: string[]): Promise<string[]> {
    if (indexes.length === 0) return [];
    const marks = indexes.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT id FROM "${table}" WHERE "${column}" IN (${marks})`)
      .bind(...indexes)
      .all<{ id: string }>();
    return res.results.map((r) => r.id);
  }

  /** The stored hash a valid handle stands for; null for anything else (then it is hashed). */
  async function resolveHandle(v: string): Promise<string | null> {
    if (!v.startsWith(SESSION_HANDLE_PREFIX)) return null;
    const [id, expS, mac, extra] = v.slice(SESSION_HANDLE_PREFIX.length).split('.');
    const exp = Number(expS);
    if (!id || !mac || extra !== undefined || !Number.isInteger(exp) || exp * 1000 < Date.now()) return null;
    const row = await db.prepare('SELECT token FROM session WHERE id = ?').bind(id).first<{ token: string }>();
    if (!row) return null;
    return timingSafeEqual(mac, await handleMac(handleSecret, id, exp, row.token)) ? row.token : null;
  }

  async function rewriteClause(model: string, w: Where, tokens: TokenMap): Promise<Where> {
    const op = w.operator ?? 'eq';
    const s = spec(model);
    if (model === 'session' && w.field === 'token') {
      if (op !== 'eq' && op !== 'in') throw new EncryptedFieldQueryError(model, 'token', `operator ${op}`);
      const hashOne = async (v: unknown) => {
        if (typeof v !== 'string') return v;
        const stored = await resolveHandle(v);
        if (stored) return stored;
        const h = await hashSessionToken(v);
        tokens.set(h, v);
        return h;
      };
      const value = Array.isArray(w.value) ? await Promise.all(w.value.map(hashOne)) : await hashOne(w.value);
      return { ...w, value: value as Where['value'] };
    }
    if (!s || !s.encrypted.includes(w.field)) return w;
    const indexColumn = s.indexed?.[w.field];
    if (!indexColumn || (op !== 'eq' && op !== 'in')) throw new EncryptedFieldQueryError(model, w.field, `operator ${op}`);
    if (w.value === null) return w;
    const values = (Array.isArray(w.value) ? w.value : [w.value]).map(String);
    const ids = await idsByIndex(s.table, indexColumn, await Promise.all(values.map(blindIndex)));
    return { field: 'id', operator: 'in', value: ids.length ? ids : [NO_MATCH], connector: w.connector };
  }

  function rewriteWhere(model: string, where: Where[], tokens: TokenMap): Promise<Where[]> {
    return Promise.all(where.map((w) => rewriteClause(model, w, tokens)));
  }

  async function rewriteOptional(model: string, where: Where[] | undefined, tokens: TokenMap) {
    return where ? rewriteWhere(model, where, tokens) : undefined;
  }

  /** Narrows an already rewritten where to one row, keeping its guards when that's safe. */
  function pinToRow(where: Where[], id: string): Where[] {
    const pin: Where = { field: 'id', operator: 'eq', value: id };
    return where.some((w) => w.connector === 'OR') ? [pin] : [...where, pin];
  }

  // ---------- writes ----------

  async function protect(model: string, data: Row, rowId: string, owner: KeyOwner | null) {
    const out: Row = { ...data };
    const indexes: Record<string, string | null> = {};
    const s = spec(model);
    if (model === 'session' && typeof data.token === 'string') out.token = await hashSessionToken(data.token);
    for (const field of s?.encrypted ?? []) {
      const value = data[field];
      if (value === undefined) continue;
      const column = s!.indexed?.[field];
      if (value === null) {
        if (column) indexes[column] = null;
        continue;
      }
      if (typeof value !== 'string') throw new Error(`${model}.${field} must be a string to be encrypted`);
      out[field] = await ring.encrypt({ table: s!.table, column: field, rowId, owner: owner! }, value);
      if (column) indexes[column] = await blindIndex(value);
    }
    return { data: out, indexes };
  }

  async function writeIndexes(model: string, id: string, indexes: Record<string, string | null>) {
    const cols = Object.keys(indexes);
    if (cols.length === 0) return;
    const set = cols.map((c) => `"${c}" = ?`).join(', ');
    await db
      .prepare(`UPDATE "${spec(model)!.table}" SET ${set} WHERE id = ?`)
      .bind(...cols.map((c) => indexes[c]), id)
      .run();
  }

  // ---------- reads ----------

  async function revealRow(model: string, row: Row, tokens: TokenMap, join?: JoinOption): Promise<Row> {
    const s = spec(model);
    const out: Row = { ...row };
    if (s && s.encrypted.some((f) => ring.isCiphertext(row[f]))) {
      const owner = ownerOf(model, row);
      for (const field of s.encrypted) {
        const v = row[field];
        if (typeof v === 'string' && ring.isCiphertext(v)) {
          out[field] = await ring.decrypt({ table: s.table, column: field, rowId: String(row.id), owner }, v);
        }
      }
    }
    if (model === 'session' && typeof row.token === 'string') {
      out.token = tokens.get(row.token) ?? (await makeSessionHandle(handleSecret, String(row.id), row.token));
    }
    for (const joined of Object.keys(join ?? {})) {
      const nested = out[joined];
      if (Array.isArray(nested)) out[joined] = await Promise.all(nested.map((r: Row) => revealRow(joined, r, tokens)));
      else if (nested && typeof nested === 'object') out[joined] = await revealRow(joined, nested as Row, tokens);
    }
    return out;
  }

  async function reveal<T>(model: string, row: T | null, tokens: TokenMap, join?: JoinOption, strip: string[] = []) {
    if (!row) return row;
    const out = await revealRow(model, row as Row, tokens, join);
    for (const f of strip) delete out[f];
    return out as T;
  }

  /** Decryption needs the row id and owner: add them to a select, and strip them afterwards. */
  function widenSelect(model: string, select: string[] | undefined) {
    const s = spec(model);
    if (!select || !s || !select.some((f) => s.encrypted.includes(f))) return { select, strip: [] as string[] };
    const strip = ownerFields(model).filter((f) => !select.includes(f));
    return { select: [...select, ...strip], strip };
  }

  function checkSort(model: string, sortBy: { field: string } | undefined) {
    if (sortBy && spec(model)?.encrypted.includes(sortBy.field)) throw new EncryptedFieldQueryError(model, sortBy.field, 'sorting');
  }

  // ---------- the adapter ----------

  const wrapped = {
    ...base,

    async create({ model, data, select, forceAllowId }) {
      const s = spec(model);
      if (!s && model !== 'session') return base.create({ model, data, select, forceAllowId });
      // Better Auth only passes an id with forceAllowId; we always choose it so AAD can bind to it.
      const given = (data as Row).id;
      const id = typeof given === 'string' && given ? given : crypto.randomUUID();
      const row: Row = { ...(data as Row), id };
      const owner = s ? ownerOf(model, row) : null;
      if (model === 'user' || model === 'organization') await ring.ensureKey(owner!);
      const tokens: TokenMap = new Map();
      const prot = await protect(model, row, id, owner);
      if (typeof row.token === 'string' && prot.data.token !== row.token) tokens.set(String(prot.data.token), row.token);
      const w = widenSelect(model, select);
      const created = await base.create({ model, data: prot.data as never, select: w.select, forceAllowId: true });
      try {
        await writeIndexes(model, id, prot.indexes);
      } catch (err) {
        // e.g. the unique emailIndex: don't leave a user nobody can find.
        await base.delete({ model, where: [{ field: 'id', value: id }] });
        throw err;
      }
      return (await reveal(model, created as Row, tokens, undefined, w.strip)) as never;
    },

    async findOne({ model, where, select, join }) {
      const tokens: TokenMap = new Map();
      const w = widenSelect(model, select);
      const res = await base.findOne<Row>({ model, where: await rewriteWhere(model, where, tokens), select: w.select, join });
      return (await reveal(model, res, tokens, join, w.strip)) as never;
    },

    async findMany({ model, where, limit, select, sortBy, offset, join }) {
      checkSort(model, sortBy);
      const tokens: TokenMap = new Map();
      const w = widenSelect(model, select);
      const rows = await base.findMany<Row>({
        model,
        where: await rewriteOptional(model, where, tokens),
        limit,
        select: w.select,
        sortBy,
        offset,
        join,
      });
      return (await Promise.all(rows.map((r) => reveal(model, r, tokens, join, w.strip)))) as never;
    },

    async count({ model, where }) {
      return base.count({ model, where: await rewriteOptional(model, where, new Map()) });
    },

    async update({ model, where, update }) {
      const tokens: TokenMap = new Map();
      const w = await rewriteWhere(model, where, tokens);
      if (!touchesProtected(model, update)) return reveal(model, await base.update<Row>({ model, where: w, update }), tokens) as never;
      const target = await base.findOne<Row>({ model, where: w });
      if (!target) return null;
      const id = String(target.id);
      const prot = await protect(model, update, id, spec(model) ? ownerOf(model, { ...target, ...update }) : null);
      const res = await base.update<Row>({ model, where: pinToRow(w, id), update: prot.data });
      if (res) await writeIndexes(model, id, prot.indexes);
      return (await reveal(model, res, tokens)) as never;
    },

    async updateMany({ model, where, update }) {
      const w = await rewriteWhere(model, where, new Map());
      if (!touchesProtected(model, update)) return base.updateMany({ model, where: w, update });
      // Each row has its own AAD (row id, owner), so encrypted values are written row by row.
      const rows = await base.findMany<Row>({ model, where: w });
      let n = 0;
      for (const row of rows) {
        const id = String(row.id);
        const prot = await protect(model, update, id, spec(model) ? ownerOf(model, { ...row, ...update }) : null);
        const res = await base.update({ model, where: [{ field: 'id', value: id }], update: prot.data });
        if (res) {
          await writeIndexes(model, id, prot.indexes);
          n++;
        }
      }
      return n;
    },

    async delete({ model, where }) {
      return base.delete({ model, where: await rewriteWhere(model, where, new Map()) });
    },

    async deleteMany({ model, where }) {
      return base.deleteMany({ model, where: await rewriteWhere(model, where, new Map()) });
    },

    async consumeOne({ model, where }) {
      const tokens: TokenMap = new Map();
      const res = await base.consumeOne<Row>({ model, where: await rewriteWhere(model, where, tokens) });
      return (await reveal(model, res, tokens)) as never;
    },

    async incrementOne({ model, where, increment, set }) {
      const tokens: TokenMap = new Map();
      let w = await rewriteWhere(model, where, tokens);
      let finalSet = set;
      if (set && touchesProtected(model, set as Row)) {
        const target = await base.findOne<Row>({ model, where: w });
        if (!target) return null;
        const id = String(target.id);
        const prot = await protect(model, set as Row, id, spec(model) ? ownerOf(model, { ...target, ...set }) : null);
        finalSet = prot.data;
        w = pinToRow(w, id);
        const res = await base.incrementOne<Row>({ model, where: w, increment, set: finalSet });
        if (res) await writeIndexes(model, id, prot.indexes);
        return (await reveal(model, res, tokens)) as never;
      }
      return (await reveal(model, await base.incrementOne<Row>({ model, where: w, increment, set: finalSet }), tokens)) as never;
    },
  } as A;

  if ('transaction' in base && typeof base.transaction === 'function') {
    // Better Auth runs transactional work on the adapter it gets here, so it must be wrapped too.
    (wrapped as DBAdapter).transaction = (cb) => (base as DBAdapter).transaction((trx) => cb(wrapAdapter(trx, deps)));
  }
  return wrapped;
}

// OWNER: agent:keys. Better Auth's `database` option: its Kysely adapter on D1, wrapped so tenant
// data is encrypted, emails are found by blind index and session tokens are stored hashed
// (adapter-wrapper.ts; D36, D49, D54).
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import type { BetterAuthOptions } from 'better-auth';
import type { DBAdapter } from 'better-auth/adapters';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import type { Env } from '../env';
import { getKeyRing } from '../keys';
import { wrapAdapter } from './adapter-wrapper';

export function createDatabase(env: Env): (options: BetterAuthOptions) => DBAdapter {
  return (options) => {
    const db = new Kysely<any>({ dialect: new D1Dialect({ database: env.DB }) });
    // D1 has no interactive transactions; Better Auth then runs "transactions" as plain calls.
    const base = kyselyAdapter(db, { type: 'sqlite', transaction: false })(options);
    return wrapAdapter(base, { ring: getKeyRing(env), db: env.DB, handleSecret: env.BETTER_AUTH_SECRET });
  };
}

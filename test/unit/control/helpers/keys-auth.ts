import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { emailOTP, organization } from 'better-auth/plugins';
import { sso } from '@better-auth/sso';
import type { Env } from '../../../../packages/platform/src/control/env';
import { createDatabase } from '../../../../packages/platform/src/control/auth/database';

/** Captured one-time codes, by email address. */
export const sentOtps = new Map<string, string>();

export function authPlugins() {
  return [
    emailOTP({
      storeOTP: 'hashed',
      async sendVerificationOTP({ email, otp }) {
        sentOtps.set(email, otp);
      },
    }),
    organization({ teams: { enabled: true } }),
    sso(),
  ];
}

/**
 * Better Auth tables for these tests. Once migrations/0001_auth.sql exists they are already
 * there and this only fills gaps; the blind-index columns are added the same way 0001 does.
 */
export async function ensureAuthSchema(env: Env): Promise<void> {
  const { runMigrations } = await getMigrations({ database: env.DB, plugins: authPlugins() } as BetterAuthOptions);
  await runMigrations();
  const want: Array<[string, string]> = [
    ['user', 'emailIndex'],
    ['invitation', 'emailIndex'],
    ['ssoProvider', 'domainIndex'],
  ];
  for (const [table, column] of want) {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
    if (!cols.results.some((c) => c.name === column)) await env.DB.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT`);
  }
  await env.DB.exec('CREATE UNIQUE INDEX IF NOT EXISTS "user_emailIndex_idx" ON "user" ("emailIndex")');
}

export function makeAuth(env: Env) {
  return betterAuth({
    database: createDatabase(env),
    secret: 'test-secret-test-secret-test-secret-0123',
    baseURL: 'http://app.localhost',
    plugins: authPlugins(),
  });
}

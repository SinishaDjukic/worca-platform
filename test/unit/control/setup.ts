import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// Every control-plane test file starts from a database with all migrations applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS as D1Migration[]);

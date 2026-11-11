import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Two projects, one per Worker. Each runs inside workerd with the Worker's dev bindings.
// The other Worker is replaced by a fake (test/fakes) so each side is tested on its own;
// the two together are covered by the end-to-end tests in test/e2e.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.control.jsonc', environment: 'dev' },
            miniflare: {
              bindings: { TEST_MIGRATIONS: await readD1Migrations('./packages/platform/migrations') },
              serviceBindings: { GATE: { name: 'fake-gate', entrypoint: 'FakeGateRpc' } },
              workers: [{ name: 'fake-gate', modules: true, scriptPath: './test/fakes/fake-gate.js', compatibilityDate: '2026-08-20' }],
            },
          })),
        ],
        test: { name: 'control', include: ['test/unit/control/**/*.test.ts', 'test/unit/shared/**/*.test.ts'], setupFiles: ['./test/unit/control/setup.ts'] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.gate.jsonc', environment: 'dev' },
            miniflare: {
              serviceBindings: { CONTROL: { name: 'fake-control', entrypoint: 'FakeControlRpc' } },
              workers: [{ name: 'fake-control', modules: true, scriptPath: './test/fakes/fake-control.js', compatibilityDate: '2026-08-20' }],
            },
          }),
        ],
        test: { name: 'gate', include: ['test/unit/gate/**/*.test.ts'] },
      },
    ],
  },
});

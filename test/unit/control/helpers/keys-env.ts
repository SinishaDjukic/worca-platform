import { env } from 'cloudflare:test';
import type { Env } from '../../../../packages/platform/src/control/env';
import { toBase64 } from '../../../../packages/platform/src/control/crypto';

/** Fixed test secrets, so the tests don't depend on .dev.vars. */
export const TEST_MASTER_KEY = toBase64(new Uint8Array(32).fill(7));
export const TEST_BLIND_INDEX_KEY = toBase64(new Uint8Array(32).fill(9));

export const TEST_AUTH_SECRET = 'test-secret-test-secret-test-secret-0123';

/**
 * The Worker's env with the fixed test secrets. KEY_ROTATION is left out by default: with it,
 * every rotateOrgKey starts a real KeyRotationWorkflow that nothing waits for or disposes. That
 * workflow outlives its test (it runs with .dev.vars keys, not these, and sleeps or retries for
 * minutes), and an instance still running when the pool shuts workerd down can keep `vitest run`
 * from exiting after all tests pass. A test that wants the workflow uses the real env and drives
 * it with introspectWorkflowInstance, disposing it at the end (see keys-rotation.test.ts).
 */
export function keysEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    MASTER_KEY: TEST_MASTER_KEY,
    BLIND_INDEX_KEY: TEST_BLIND_INDEX_KEY,
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    KEY_ROTATION: undefined,
    ...overrides,
  };
}

export const uid = () => crypto.randomUUID();

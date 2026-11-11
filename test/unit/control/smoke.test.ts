import { env, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('serves /health with migrations applied', async () => {
  const res = await SELF.fetch('http://app.localhost/health');
  expect(res.status).toBe(200);
  expect(await (env.GATE as unknown as { calls(): Promise<unknown[]> }).calls()).toEqual([]);
});

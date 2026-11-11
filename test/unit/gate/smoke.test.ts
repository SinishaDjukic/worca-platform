import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('bundles and answers', async () => {
  const res = await SELF.fetch('http://abc.run.localhost/');
  expect(res.status).toBeGreaterThan(0);
});

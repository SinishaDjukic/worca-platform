// The web UI route (src/control/ui.ts): the app shell only for signed-in people, static files
// under /assets/, and API or server-page paths never answered with the shell.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = env.APP_ORIGIN;
let seq = 0;

async function signIn(): Promise<string> {
  const email = `ui-${Date.now()}-${++seq}@example.com`;
  const post = (path: string, body: unknown) =>
    SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
  expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
  const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
  const otp = /code: (\d{6})/.exec(mails.at(-1)!.subject)![1]!;
  const res = await post('/api/auth/sign-in/email-otp', { email, otp });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe('web UI', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'open', 0)
       ON CONFLICT (key) DO UPDATE SET value = 'open'`,
    ).run();
  });

  it('sends signed-out visitors of app routes to /sign-in with the way back', async () => {
    const res = await SELF.fetch(`${ORIGIN}/o/org_1/members?tab=x`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fo%2Forg_1%2Fmembers%3Ftab%3Dx');
  });

  it('serves the shell to signed-in people, with the page CSP and no-store', async () => {
    const cookie = await signIn();
    const res = await SELF.fetch(`${ORIGIN}/platform/orgs`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('/assets/js/main.mjs');
    expect(html).toContain('<link rel="stylesheet" href="/assets/theme.css">');
    // This deployment's names reach the scripts as data- attributes on <body>, not as text in ui/.
    expect(html).toContain('<title>Worca</title>');
    expect(html).toMatch(/<body data-product="Worca" data-service="Worca hosted"[^>]* data-instance-domain="run\.localhost" data-features="newsletter accessRequests tiers">/);
  });

  it('brands the shell with the deployment\'s names, escaped', async () => {
    const { brandShell } = await import('../../../packages/platform/src/control/ui');
    const { siteOf } = await import('../../../packages/platform/src/shared/site');
    const site = siteOf({ APP_ORIGIN: 'https://app.example.com', INSTANCE_DOMAIN: 'example.net', PRODUCT_NAME: 'A "B" <C>', ABUSE_EMAIL: 'abuse@example.com' });
    const html = brandShell('<html><head><title>Worca</title></head><body><div id="app"></div></body></html>', site);
    expect(html).toContain('<title>A &quot;B&quot; &lt;C&gt;</title>');
    expect(html).toContain('<body data-product="A &quot;B&quot; &lt;C&gt;" data-service="A &quot;B&quot; &lt;C&gt; hosted" data-abuse-email="abuse@example.com" data-instance-domain="example.net">');
    expect(html).not.toContain('data-operator');
    expect(html).not.toContain('data-features'); // no module on
    expect(brandShell('<body>', site, ['newsletter', 'tiers'])).toContain(' data-features="newsletter tiers">');
  });

  it('serves static files under /assets/ and 404s unknown ones as JSON', async () => {
    const css = await SELF.fetch(`${ORIGIN}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('no-cache');
    await css.arrayBuffer();
    const font = await SELF.fetch(`${ORIGIN}/assets/fonts/poppins-latin-400-normal.woff2`);
    expect(font.headers.get('cache-control')).toContain('max-age=604800');
    await font.arrayBuffer();
    const theme = await SELF.fetch(`${ORIGIN}/assets/theme.css`);
    expect(theme.status).toBe(200); // the deployment's colour overrides; only a comment by default
    expect((await theme.text()).replace(/\/\*[\s\S]*?\*\//g, "").trim()).toBe("");
    const missing = await SELF.fetch(`${ORIGIN}/assets/nope.js`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('never answers API, server-page or file-like paths with the shell', async () => {
    const cookie = await signIn();
    for (const path of ['/api/nope', '/api/orgs/x/nope/deeper', '/confirm', '/auth/nope', '/robots.txt', '/index.html']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie }, redirect: 'manual' });
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toContain('application/json');
      await res.arrayBuffer();
    }
  });
});

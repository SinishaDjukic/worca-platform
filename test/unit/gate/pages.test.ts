// The gate's own pages (pages.ts): look and CSP, the branded 404 for unknown hosts, and the
// apex / www redirect (D67).
import { describe, expect, it } from 'vitest';
import { GATE_PATHS } from '../../../packages/platform/src/shared/contracts';
import {
  creatingPage, errorPage, notFoundPage, pageCsp, recoveryPage, signedOutPage, startingPage, stoppedPage, unresponsivePage,
  upgradingPage,
} from '../../../packages/platform/src/gate/pages';
import { apexRedirect, instanceHost } from '../../../packages/platform/src/gate/handler';
import { siteOf } from '../../../packages/platform/src/shared/site';
import { env, gate } from './helpers';

const SITE = siteOf(env);
const ABOUT_URL = SITE.aboutUrl;

const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };

/** The nonce of the page CSP, which every inline style and script must carry. */
function nonceOf(res: Response): string {
  const m = /style-src 'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '');
  expect(m, 'page CSP with a nonce').toBeTruthy();
  return m![1]!;
}

describe('gate pages', () => {
  const pages: [string, () => Response, number][] = [
    ['starting', () => startingPage(SITE), 503],
    ['upgrading', () => upgradingPage(SITE), 503],
    ['creating', () => creatingPage(SITE), 503],
    ['stopped', () => stoppedPage(SITE), 403],
    ['recovery', () => recoveryPage(SITE), 400],
    ['signed out', () => signedOutPage(SITE), 200],
    ['error', () => errorPage(SITE, 502, 'x'), 502],
    ['not found', () => notFoundPage(SITE), 404],
    ['unresponsive', () => unresponsivePage(SITE, { host: 'k7m2qz9xwp.worca.run', appOrigin: 'https://app.worca.dev' }), 504],
  ];

  it.each(pages)('%s: styled, nonce CSP, no inline handlers or external resources', async (_name, make, status) => {
    const res = make();
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy')!;
    const n = nonceOf(res);
    expect(csp).toBe(pageCsp(n));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain(`<style nonce="${n}">`);
    for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${n}"`);
    expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers
    expect(html).not.toMatch(/style="/); // no inline style attributes
    expect(html).not.toMatch(/(src|href)="\/\//); // nothing protocol-relative
    expect(html).toContain(`href="${ABOUT_URL}"`);
    expect(html).toContain('class="logo"');
  });

  it('unresponsive: names the instance, retries by itself, and only ever links back to this origin', async () => {
    const res = unresponsivePage(SITE, { host: 'k7m2qz9xwp.worca.run', path: '/p?a=<b>', status: 502 });
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("<h1>k7m2qz9xwp.worca.run isn&#39;t answering right now</h1>");
    expect(html).toContain('id="retry-in"');
    expect(html).toContain('href="/p?a=&#60;b&#62;"');
    for (const path of ['//evil.example/x', '/\\evil.example', 'https://evil.example/']) {
      expect(await unresponsivePage(SITE, { host: 'h.worca.run', path }).text()).toContain('href="/"');
    }
  });

  it('a fresh nonce per response', () => {
    expect(nonceOf(startingPage(SITE))).not.toBe(nonceOf(startingPage(SITE)));
  });

  it('starting: "Suspended for the moment", polls the status path; upgrading and creating poll too', async () => {
    const html = await startingPage(SITE).text();
    expect(html).toMatch(/starting/i);
    expect(html).toContain('Suspended for the moment');
    expect(html).toContain(GATE_PATHS.status);
    for (const make of [upgradingPage, creatingPage]) expect(await make(SITE).text()).toContain(GATE_PATHS.status);
    expect(await stoppedPage(SITE).text()).not.toContain('<script');
  });

  it('stopped: abuse contact (D58), from the deployment, or none', async () => {
    const html = await stoppedPage(SITE).text();
    expect(html).toContain('Stopped by the platform');
    expect(html).toContain(`mailto:${env.ABUSE_EMAIL}`);
    const own = await stoppedPage(siteOf({ ...env, ABUSE_EMAIL: 'abuse@example.com', ABUSE_URL: 'https://example.com/report' })).text();
    expect(own).toContain('write to <a href="mailto:abuse@example.com">abuse@example.com</a> or use the form on <a href="https://example.com/report">example.com</a>');
    const bare = await stoppedPage(siteOf({ APP_ORIGIN: env.APP_ORIGIN, INSTANCE_DOMAIN: env.INSTANCE_DOMAIN })).text();
    expect(bare).not.toContain('To report abuse');
    expect(bare).toContain(`href="${env.APP_ORIGIN}"`); // "What is this?" falls back to the app
  });

  it('escapes the host and the error message', async () => {
    expect(await notFoundPage(SITE, { host: '<b>' }).text()).toContain('&#60;b&#62;');
    expect(await errorPage(SITE, 400, '<script>x</script>').text()).not.toContain('<script>x');
  });
});

describe('branding', () => {
  it('names the product and the service from the deployment, and inlines its own gate logo', async () => {
    const { definePlatform, resetPlatform } = await import('../../../packages/platform/src/shared/platform');
    const { LOGO_MASK_DATA_URI } = await import('../../../packages/platform/src/gate/logo');
    const site = siteOf({ ...env, PRODUCT_NAME: 'Acme Cloud', SERVICE_NAME: 'Acme Workspaces' });
    let html = await notFoundPage(site, {}).text();
    expect(html).toContain('<title>No instance here · Acme Cloud</title>');
    expect(html).toContain('aria-label="Acme Cloud"');
    expect(html).toContain('Acme Workspaces · <a');
    expect(html).toContain('What is Acme Workspaces?');
    expect(html).toContain(LOGO_MASK_DATA_URI);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    try {
      definePlatform({ name: 'acme', environments: { dev: { appOrigin: 'https://app.example.com', instanceDomain: 'example.net' } }, mail: { from: 'a@example.com' } }, { branding: { gateLogo: { mask: png, aspect: '100/50' } } });
      html = await notFoundPage(site, {}).text();
      expect(html).toContain('url(data:image/png;base64,iVBORw0KGgo=)');
      expect(html).toContain('aspect-ratio:100/50');
      expect(html).not.toContain(LOGO_MASK_DATA_URI);
    } finally {
      resetPlatform();
    }
  });
});

describe('unknown hosts', () => {
  it('a well-formed host without an instance gets "No instance here" with links to the app and the about page', async () => {
    const res = await gate(new Request('http://nobody0000.run.localhost/some/path', { headers: nav }));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('No instance here');
    expect(html).toContain('nobody0000.run.localhost');
    expect(html).toContain(`href="${env.APP_ORIGIN}"`);
    expect(html).toContain(`href="${ABOUT_URL}"`);
  });

  it('other domains get the page without echoing the host', async () => {
    const res = await gate(new Request('http://evil.example.com/'));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('evil.example.com');
  });

  it('www is never an instance host', () => {
    expect(instanceHost(new Request('http://www.run.localhost/'), env)).toBeNull();
    expect(instanceHost(new Request('http://abc.run.localhost/'), env)).toBe('abc.run.localhost');
  });
});

describe('apex and www redirect (D67)', () => {
  it.each(['http://run.localhost/', 'http://www.run.localhost/a/b?c=1', 'http://WWW.run.localhost:8788/'])('%s -> 301 to the about page', async (url) => {
    const res = await gate(new Request(url, { headers: nav }));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(env.APEX_REDIRECT_URL ?? ABOUT_URL);
    expect(res.headers.get('x-frame-options')).toBe('DENY'); // security headers as everywhere
  });

  it('before anything else: no cookie check, no sign-in, any method', async () => {
    const flood = await gate(new Request('http://run.localhost/', { method: 'POST', headers: { cookie: `x=${'y'.repeat(9000)}` } }));
    expect(flood.status).toBe(301);
  });

  it('the target is a var; the default is the about page, else the app', () => {
    const res = apexRedirect(new Request('http://www.worca.run/'), { ...env, INSTANCE_DOMAIN: 'worca.run', APEX_REDIRECT_URL: 'https://example.test/x' });
    expect(res?.headers.get('location')).toBe('https://example.test/x');
    const fallback = apexRedirect(new Request('http://worca.run/'), { ...env, INSTANCE_DOMAIN: 'worca.run', APEX_REDIRECT_URL: undefined, ABOUT_URL: 'https://example.test/about' });
    expect(fallback?.headers.get('location')).toBe('https://example.test/about');
    const bare = apexRedirect(new Request('http://worca.run/'), { ...env, INSTANCE_DOMAIN: 'worca.run', APEX_REDIRECT_URL: undefined, ABOUT_URL: undefined });
    expect(bare?.headers.get('location')).toBe(env.APP_ORIGIN);
  });

  it('instance hosts and other domains are not redirected', () => {
    expect(apexRedirect(new Request('http://abc.run.localhost/'), env)).toBeNull();
    expect(apexRedirect(new Request('http://wwww.run.localhost/'), env)).toBeNull();
    expect(apexRedirect(new Request('http://run.localhost.evil.com/'), env)).toBeNull();
  });
});

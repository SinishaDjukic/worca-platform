// Server-rendered pages (auth/pages.ts): the app's stylesheets, no inline styles or scripts, the
// sign-up code field per registration mode, D23 "sign in again", and the confirmation page CSP.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  APP_CSS_PATH, PAGES_CSS_PATH, SIGN_IN_JS_PATH, STRICT_PAGE_CSP, invitePage, messagePage, signInPage, signOutPage,
} from '../../../packages/platform/src/control/auth/pages';
import { siteOf } from '../../../packages/platform/src/shared/site';

const ORIGIN = env.APP_ORIGIN;
const SITE = siteOf(env);
const base = { next: '/', google: false, microsoft: false, mode: 'open' as const, site: SITE };

function expectAppLook(html: string) {
  expect(html).toContain(`<link rel="stylesheet" href="${APP_CSS_PATH}">`);
  expect(html).toContain(`<link rel="stylesheet" href="${PAGES_CSS_PATH}">`);
  expect(html).toContain('class="logo"');
  expect(html).toContain(`href="${SITE.aboutUrl}"`);
  expect(html).not.toMatch(/style="/); // CSP style-src 'self'
  expect(html).not.toMatch(/<style/);
  expect(html).not.toMatch(/<script>(?!<\/script>)/); // only src= scripts
  expect(html).not.toMatch(/\son[a-z]+=/i);
}

describe('page markup', () => {
  it('sign-in keeps the element ids the script and the tests use', () => {
    const html = signInPage(base);
    expectAppLook(html);
    for (const id of ['signin', 'status', 'email-step', 'email', 'sso', 'code-step', 'otp', 'restart', 'passkey']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain(`<script src="${SIGN_IN_JS_PATH}" defer></script>`);
    expect(html).toMatch(/<form id="code-step"[^>]*hidden/);
    expect(html).not.toContain('signup-code');
    expect(html).not.toContain('data-provider');
  });

  it.each([
    ['invite_code', /invite-only/],
    ['waitlist', /waitlist/],
  ] as const)('%s mode: the sign-up code field, labelled and explained', (mode, hint) => {
    const html = signInPage({ ...base, mode });
    expect(html).toContain('<label for="signup-code">');
    expect(html).toContain('id="signup-code" name="signupCode"');
    expect(html).toContain('aria-describedby="signup-code-hint"');
    expect(html).toMatch(hint);
  });

  it('social buttons only when configured; Turnstile only with a site key', () => {
    const html = signInPage({ ...base, google: true, microsoft: true, turnstileSiteKey: 'k"1' });
    expect(html).toContain('data-provider="google"');
    expect(html).toContain('data-provider="microsoft"');
    expect(html).toContain('data-sitekey="k&quot;1"');
    expect(html).toContain('challenges.cloudflare.com/turnstile');
  });

  it('D23: names the methods the instance accepts; ignores unknown ones', () => {
    const html = signInPage({ ...base, methods: ['sso', 'passkey', 'bogus'] });
    expect(html).toContain('id="policy-note"');
    expect(html).toContain("your company&#39;s single sign-on or a passkey");
    expect(signInPage(base)).not.toContain('policy-note');
  });

  it('escapes next, the error, org names and links', () => {
    expect(signInPage({ ...base, next: '/"><x', error: '<b>' })).not.toMatch(/"><x|<b>/);
    const inv = invitePage({ invitationId: 'a/b', orgName: '<Org>', inviterEmail: '"x"@y', site: SITE });
    expectAppLook(inv);
    expect(inv).toContain('&lt;Org&gt;');
    expect(inv).toContain('action="/invite/a%2Fb"');
    expect(messagePage('<t>', '<p>', { href: '"x', label: '<l>' }, { site: SITE })).not.toMatch(/<t>|<p>x|"x"|<l>/);
    expectAppLook(signOutPage(SITE));
    expect(signOutPage(SITE)).toContain('<form method="post" action="/sign-out"');
  });
});

describe('served pages', () => {
  it('/sign-in under the page CSP, with the code field outside open mode', async () => {
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'waitlist', 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    const res = await SELF.fetch(`${ORIGIN}/sign-in?next=/x`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("style-src 'self'");
    const html = await res.text();
    expect(html).toContain('id="signup-code"');
    expect(html).toContain('data-next="/x"');
  });

  it('/auth/sign-in.js is served as JavaScript', async () => {
    const res = await SELF.fetch(`${ORIGIN}${SIGN_IN_JS_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toContain("$('email-step')");
  });

  it('/sign-in?methods=… is shown even to a signed-in person (D23); without methods they go on', async () => {
    await env.DB.prepare(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('registration_mode', 'open', 0)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    const email = `pages-d23-${Date.now()}@example.com`;
    const post = (path: string, body: unknown) =>
      SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) });
    expect((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status).toBe(200);
    const mails = (await (await SELF.fetch(`${ORIGIN}/__dev/mail?to=${encodeURIComponent(email)}`)).json()) as { subject: string }[];
    const otp = /(\d{6})/.exec(mails.at(-1)!.subject)![1];
    const signedIn = await post('/api/auth/sign-in/email-otp', { email, otp });
    const cookie = signedIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const again = await SELF.fetch(`${ORIGIN}/sign-in?next=/authorize&methods=sso,nope`, { headers: { cookie }, redirect: 'manual' });
    expect(again.status).toBe(200);
    const html = await again.text();
    expect(html).toContain('id="policy-note"');
    expect(html).not.toContain('nope');
    const onward = await SELF.fetch(`${ORIGIN}/sign-in?next=/authorize&methods=nope`, { headers: { cookie }, redirect: 'manual' });
    expect(onward.headers.get('location')).toBe('/authorize');
  });

  it('a confirmation link without a session: strict CSP, the app look, a sign-in link that comes back', async () => {
    const res = await SELF.fetch(`${ORIGIN}/confirm/abc?t=tok`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toBe(STRICT_PAGE_CSP);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const html = await res.text();
    expectAppLook(html);
    expect(html).toContain('href="/sign-in?next=%2Fconfirm%2Fabc%3Ft%3Dtok"');
  });
});

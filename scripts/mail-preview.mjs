// `node scripts/mail-preview.mjs [--shots [dir]]`: renders every mail template with sample data
// into .mail-preview/ (gitignored): <name>.html, <name>.txt (the plain-text part) and an
// index.html linking them all. Open .mail-preview/index.html in a browser.
//
// --shots [dir]  also screenshots each mail with Playwright (Chromium): light and dark
//                (prefers-color-scheme) at 600 and 375 px wide, into dir (default
//                .mail-preview/shots). The logo is served from the local ui/assets/mail/, so it
//                shows before it is deployed to app.example.com.
//
// The templates are TypeScript; esbuild (installed with wrangler) bundles them for Node first.
// Browsers are not mail clients: this checks the design, not Outlook or Gmail quirks (see
// docs/development.md, "Email design").
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.mail-preview');
const args = process.argv.slice(2);
const shotsAt = args.indexOf('--shots');
const shotsDir = shotsAt >= 0 ? resolve(args[shotsAt + 1] && !args[shotsAt + 1].startsWith('--') ? args[shotsAt + 1] : join(out, 'shots')) : null;

const APP = 'https://app.example.com';

// One entry that imports every template module and renders them with sample data.
const entry = `
import * as auth from './packages/platform/src/control/auth/email';
import * as news from './packages/platform/src/control/newsletter/mails';
import * as access from './packages/platform/src/control/public/access-request-mail';
import { siteOf } from './packages/platform/src/shared/site';

const APP = ${JSON.stringify(APP)};
const env = { APP_ORIGIN: APP, INSTANCE_DOMAIN: 'example.net', EMAIL_FROM: 'Worca <no-reply@example.com>', NEWSLETTER_POSTAL_ADDRESS: 'Example Hosting, Example Street 1, 10115 Berlin', OPERATOR_NAME: 'Example Hosting', WEBSITE_URL: 'https://example.com', CONTACT_EMAIL: 'hello@example.com', ABUSE_EMAIL: 'abuse@example.com', PRIVACY_URL: 'https://example.com/privacy/', TERMS_URL: 'https://example.com/terms/', LEGAL_URL: 'https://example.com/legal/' };
const site = siteOf(env);
const links = news.newsletterLinks(env, 'sample-token');
// GitHub's generated release body, as the release workflow sends it.
const notes = [
  "## What's Changed",
  '* A stop ends the container with exit 0 by @SinishaDjukic in https://github.com/SinishaDjukic/worca-cc/pull/610',
  '* Broker key page: \`__Host-\` CSRF cookie over https by @SinishaDjukic in https://github.com/SinishaDjukic/worca-cc/pull/612',
  '',
  '**Full Changelog**: https://github.com/SinishaDjukic/worca-cc/compare/worca-app-v1.9.0...worca-app-v1.9.1',
].join('\\n');

export const mails = {
  'sign-in-code': auth.signInCodeEmail('482913', site),
  'passkey-added': auth.passkeyAddedEmail(site),
  'org-invitation': auth.orgInvitationEmail({ orgName: 'Acme Robotics', inviterName: 'The Acme admin team', invitationId: 'inv_123', site }),
  'action': auth.actionEmail('Confirm your new email address', 'You asked to change the email address of your Worca account.\\n\\nPress the button to confirm it.', 'Confirm address', APP + '/confirm/abc?t=x', site),
  'confirm-action': auth.confirmActionEmail({ label: 'Delete instance acme-main', summary: 'Delete the instance acme-main (https://acme-main.example.net) and everything on it.', link: APP + '/confirm/c_1?t=token', site }),
  'sign-in-reset': auth.signInResetEmail(site),
  'notice-instance-ready': { subject: 'Your Worca instance acme-main is ready', text: 'acme-main is running at https://acme-main.example.net', html: auth.noticeEmailHtml({ subject: 'Your Worca instance acme-main is ready', text: 'acme-main is running at https://acme-main.example.net', site }) },
  'notice-abuse-stop': (() => {
    const subject = 'Your Worca instance was stopped';
    const text = 'The instance https://acme-main.example.net was stopped by the platform for abuse.\\n\\nReason: outbound spam from the container.\\n\\nReply to abuse@example.com if you think this is a mistake.';
    return { subject, text, html: auth.noticeEmailHtml({ subject, text, site }) };
  })(),
  'access-confirm': access.accessConfirmEmail(APP + '/access-request#t=token', site),
  'access-granted': access.accessGrantedEmail({ code: 'K7Q2M-ZX4PA-9HW3R', expiresAt: Date.UTC(2026, 9, 21), message: 'Welcome aboard! Ping us on Discord if anything is unclear.', site }),
  'access-declined': access.accessDeclinedEmail({ message: 'We are onboarding teams in small batches this month.', site }),
  'access-staff-notice': access.accessStaffNoticeEmail({ fresh: 3, pending: 7, site }),
  'newsletter-confirm': news.confirmSubscriptionEmail(env, { subscriberId: 's1', token: 'tok', releases: 'minor', product: true }),
  'newsletter-manage-link': news.manageLinkEmail(env, { subscriberId: 's1', token: 'tok' }),
  'newsletter-release': news.issueMail(env, { kind: 'release', version: '2.4.0', release_level: 'minor', subject: 'Worca 2.4.0 is out', url: 'https://docs.worca.dev/changelog/' }, links, notes),
  'newsletter-rc': news.issueMail(env, { kind: 'release', version: '2.5.0-rc.1', release_level: 'rc', subject: 'Worca 2.5.0-rc.1', url: 'https://docs.worca.dev/changelog/' }, links, null),
  'newsletter-product': news.issueMail(env, { kind: 'product', version: null, release_level: null, subject: 'Ask Worca now knows your runs', url: null }, links, 'Ask Worca answers questions about your pipeline runs: why a step failed, what it cost, which model did what.'),
};
`;

const bundle = join(out, '.bundle.mjs');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'warning' });
const { mails } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

const names = Object.keys(mails);
for (const name of names) {
  writeFileSync(join(out, `${name}.html`), mails[name].html);
  writeFileSync(join(out, `${name}.txt`), `Subject: ${mails[name].subject}\n\n${mails[name].text}`);
}
const rows = names.map((n) => `<li><a href="${n}.html">${n}</a> &middot; <a href="${n}.txt">text</a> &mdash; ${mails[n].subject.replace(/</g, '&lt;')}</li>`).join('\n');
writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mail preview</title><body style="font:15px/1.6 system-ui;margin:32px"><h1>Worca mails</h1><ul>${rows}</ul></body>`);
console.log(`${names.length} mails rendered into ${out}`);

if (shotsDir) {
  const { chromium } = await import('playwright');
  mkdirSync(shotsDir, { recursive: true });
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    for (const width of [600, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: scheme, deviceScaleFactor: 2 });
      await page.route(`${APP}/assets/mail/*`, (route) =>
        route.fulfill({ contentType: 'image/png', body: readFileSync(join(root, 'packages/platform/ui', new URL(route.request().url()).pathname)) }),
      );
      for (const name of names) {
        await page.goto(pathToFileURL(join(out, `${name}.html`)).href, { waitUntil: 'networkidle' }).catch(() => {});
        await page.screenshot({ path: join(shotsDir, `${name}-${scheme}-${width}.png`), fullPage: true });
      }
      await page.close();
    }
  }
  await browser.close();
  console.log(`screenshots in ${shotsDir}`);
}

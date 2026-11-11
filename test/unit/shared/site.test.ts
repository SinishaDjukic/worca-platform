import { describe, expect, it } from 'vitest';
import { noticeEmailHtml, signInCodeEmail } from '../../../packages/platform/src/control/auth/email';
import { accessDeclinedEmail } from '../../../packages/platform/src/control/public/access-request-mail';
import { siteOf, websiteHost } from '../../../packages/platform/src/shared/site';

const bare = { APP_ORIGIN: 'https://app.example.com/', INSTANCE_DOMAIN: 'Example.NET' };
const full = {
  ...bare,
  OPERATOR_NAME: 'Example Hosting',
  WEBSITE_URL: 'https://www.example.com/',
  ABOUT_URL: 'https://www.example.com/hosted/',
  CONTACT_EMAIL: 'hello@example.com',
  PRIVACY_URL: 'https://www.example.com/privacy/',
  LEGAL_URL: 'https://www.example.com/legal/',
};

describe('site settings', () => {
  it('falls back to the app and leaves out what is unset', () => {
    const site = siteOf(bare);
    expect(site).toEqual({
      appOrigin: 'https://app.example.com',
      instanceDomain: 'example.net',
      productName: 'Worca',
      serviceName: 'Worca hosted',
      mailLogo: { width: 148, height: 44 },
      operatorName: null,
      websiteUrl: null,
      aboutUrl: 'https://app.example.com',
      contactEmail: null,
      abuseEmail: null,
      abuseUrl: null,
      legal: [],
      linkDomains: ['app.example.com', 'example.net'],
    });
    expect(websiteHost(site)).toBeNull();
  });

  it('takes the operator, links and the website domain for links in mail', () => {
    const site = siteOf({ ...full, ABOUT_URL: ' ' });
    expect(site.aboutUrl).toBe('https://www.example.com/'); // blank counts as unset: the website
    expect(site.abuseEmail).toBe('hello@example.com'); // abuse reports go to the contact address
    expect(site.legal).toEqual([
      ['Privacy', 'https://www.example.com/privacy/'],
      ['Legal', 'https://www.example.com/legal/'],
    ]);
    expect(site.linkDomains).toEqual(['app.example.com', 'example.net', 'www.example.com']);
    expect(websiteHost(site)).toBe('www.example.com');
  });

  it('names the product and the service, and sizes the mail logo, as the deployment sets them', () => {
    const site = siteOf({ ...bare, PRODUCT_NAME: 'Acme Cloud', MAIL_LOGO_SIZE: '120x40' });
    expect(site.productName).toBe('Acme Cloud');
    expect(site.serviceName).toBe('Acme Cloud hosted');
    expect(site.mailLogo).toEqual({ width: 120, height: 40 });
    expect(siteOf({ ...bare, SERVICE_NAME: 'Acme Workspaces', MAIL_LOGO_SIZE: 'big' })).toMatchObject({ serviceName: 'Acme Workspaces', mailLogo: { width: 148, height: 44 } });
    const html = signInCodeEmail('123456', site).html;
    expect(html).toContain('alt="Acme Cloud"');
    expect(html).toContain('width="120" height="40"');
  });

  it('mail without operator settings carries no foreign links or lines', () => {
    const html = signInCodeEmail('123456', siteOf(bare)).html;
    expect(html).toContain('href="https://app.example.com"');
    expect(html).not.toMatch(/worca\.(dev|run)/);
    expect(html).not.toContain('mailto:');
    expect(accessDeclinedEmail({ site: siteOf(bare) }).text).toContain('You can ask again later.\n');
  });

  it('mail with them names the operator and links the website, the contact and the legal pages', () => {
    const site = siteOf(full);
    const html = signInCodeEmail('123456', site).html;
    for (const href of ['https://www.example.com/', 'mailto:hello@example.com', 'https://www.example.com/privacy/', 'https://www.example.com/legal/']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('Example Hosting');
    expect(html).toContain('>www.example.com</a>');
    expect(noticeEmailHtml({ subject: 's', text: 'see https://www.example.com/x and https://a.example.net', site })).toMatch(
      /href="https:\/\/www\.example\.com\/x".*href="https:\/\/a\.example\.net"/s,
    );
    expect(accessDeclinedEmail({ site }).text).toContain('You can ask again later at www.example.com.');
  });
});

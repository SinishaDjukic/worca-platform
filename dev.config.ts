// The contributors' local stack and the unit tests: the root wrangler.*.jsonc are what this
// generates (test/unit/shared/deployment-config.test.ts checks it). Fake compute and edge providers,
// run.localhost, every optional module on so the tests cover them. Not a deployment: deployments
// get their own worca.config.ts from @worca/create-platform.
import type { PlatformConfigInput } from '@worca/platform';

export default {
  name: 'worca-platform',
  environments: {
    dev: {
      appOrigin: 'http://app.localhost:8787',
      instanceDomain: 'run.localhost',
      apexRedirectUrl: 'https://example.com/hosted/',
      publicFormOrigins: ['http://localhost:8080'],
      instanceScheme: 'http',
      instanceOriginSuffix: ':8798',
      local: true,
      providers: { compute: 'fake', edge: 'fake' },
      stubAdminUrl: 'http://127.0.0.1:9100',
    },
  },
  mail: {
    from: 'Worca <no-reply@example.com>',
    newsletterFrom: 'Worca <news@news.example.com>',
  },
  providers: { compute: 'railway', edge: 'cloudflare' },
  features: { newsletter: true, accessRequests: true, tiers: true },
  branding: {
    operatorName: 'Example Hosting',
    websiteUrl: 'https://example.com',
    aboutUrl: 'https://example.com/hosted/',
    contactEmail: 'hello@example.com',
    abuseEmail: 'abuse@example.com',
    abuseUrl: 'https://example.com/abuse',
    privacyUrl: 'https://example.com/privacy/',
    termsUrl: 'https://example.com/terms/',
    legalUrl: 'https://example.com/legal/',
  },
} satisfies PlatformConfigInput;

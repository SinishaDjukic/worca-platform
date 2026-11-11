// This deployment's settings: edit here, then `npm run deploy` (it regenerates the wrangler
// configs). Every option: node_modules/@worca/platform/README.md and docs/deploy.md in the
// worca-platform repository.
import { defineConfig } from '@worca/platform';

export default defineConfig({
  name: {{NAME}},
  environments: {
    // Cloudflare: npm run setup, npm run deploy.
    prod: {
      appOrigin: {{APP_ORIGIN}},
      instanceDomain: {{INSTANCE_DOMAIN}},
    },
    // Your machine: npm run dev, with the fake providers (no Cloudflare, no compute account).
    dev: {
      appOrigin: 'http://app.localhost:8787',
      instanceDomain: 'run.localhost',
      instanceScheme: 'http',
      instanceOriginSuffix: ':8798',
      local: true,
      providers: { compute: 'fake', edge: 'fake' },
      stubAdminUrl: 'http://127.0.0.1:9100',
    },
  },
  mail: { from: {{MAIL_FROM}} },
  providers: { compute: {{COMPUTE}}, edge: 'cloudflare' },
  features: {{FEATURES}},
  branding: {},
});

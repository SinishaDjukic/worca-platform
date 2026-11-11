import { describe, expect, it } from 'vitest';
import { parsePlatformConfig, resourceNames, wranglerVars, type PlatformConfigInput } from '../../../packages/platform/src/shared/config';
import { definePlatform, platform } from '../../../packages/platform/src/shared/platform';

const minimal: PlatformConfigInput = {
  name: 'acme',
  environments: { prod: { appOrigin: 'https://app.example.com', instanceDomain: 'example.net' } },
  mail: { from: 'Acme <no-reply@example.com>' },
};

describe('platform config', () => {
  it('fills defaults for everything optional', () => {
    const c = parsePlatformConfig(minimal);
    expect(c.providers).toEqual({ compute: 'railway', edge: 'cloudflare' });
    expect(c.branding).toEqual({});
    expect(c.images).toEqual({});
    expect(c.mail.provider).toBe('resend');
    expect(c.gate).toEqual({ passSeconds: 60, idleSeconds: 86400, recheckSeconds: 3600, scheduleWakeLeadSeconds: 600 });
    expect(c.environments.prod).toMatchObject({ publicFormOrigins: [], instanceScheme: 'https', instanceOriginSuffix: '', local: false });
  });

  it('derives every resource name from the prefix and the environment', () => {
    const c = parsePlatformConfig({ ...minimal, environments: { ...minimal.environments, dev: { appOrigin: 'http://app.localhost:8787', instanceDomain: 'run.localhost' } } });
    expect(resourceNames(c, 'prod')).toEqual({
      control: 'acme-control-prod',
      gate: 'acme-gate-prod',
      database: 'acme-db-prod',
      instanceOps: 'acme-instance-ops-prod',
      keyRotation: 'acme-key-rotation-prod',
      newsletterSend: 'acme-newsletter-send-prod',
    });
    expect(resourceNames(c, 'dev').gate).toBe('acme-gate-dev');
  });

  it('places the database by jurisdiction or location, not both', () => {
    expect(parsePlatformConfig(minimal).database).toEqual({});
    expect(parsePlatformConfig({ ...minimal, database: { jurisdiction: 'eu' } }).database).toEqual({ jurisdiction: 'eu' });
    expect(parsePlatformConfig({ ...minimal, database: { location: 'weur' } }).database).toEqual({ location: 'weur' });
    expect(() => parsePlatformConfig({ ...minimal, database: { jurisdiction: 'eu', location: 'weur' } })).toThrow(/not both/);
    expect(() => parsePlatformConfig({ ...minimal, database: { jurisdiction: 'us' } as never })).toThrow();
  });

  it('takes single name overrides, with {env}', () => {
    const c = parsePlatformConfig({ ...minimal, names: { database: 'shared-db-{env}', gate: 'edge' } });
    expect(resourceNames(c, 'prod')).toMatchObject({ database: 'shared-db-prod', gate: 'edge', control: 'acme-control-prod' });
  });

  it('refuses bad values with every problem listed', () => {
    const bad = {
      ...minimal,
      name: 'Acme!',
      environments: { prod: { appOrigin: 'https://app.example.com/path', instanceDomain: 'https://example.net' } },
      mail: { from: 'nobody' },
      branding: { contactEmail: 'not-an-address' },
    };
    let message = '';
    try {
      parsePlatformConfig(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const path of ['name', 'environments.prod.appOrigin', 'environments.prod.instanceDomain', 'mail.from', 'branding.contactEmail']) expect(message).toContain(path);
  });

  it('refuses unknown keys, an empty environment list and images in the wrong form', () => {
    expect(() => parsePlatformConfig({ ...minimal, colour: 'red' })).toThrow(/colour/);
    expect(() => parsePlatformConfig({ ...minimal, environments: {} })).toThrow(/at least one environment/);
    expect(() => parsePlatformConfig({ ...minimal, images: { worca: 'ghcr.io/acme/worca:1.0.0' } })).toThrow(/without a tag/);
    expect(() => parsePlatformConfig({ ...minimal, images: { cloudflared: 'cloudflare/cloudflared' } })).toThrow(/with a tag/);
    expect(parsePlatformConfig({ ...minimal, images: { worca: 'registry.example.com:5000/acme/worca', cloudflared: 'cloudflare/cloudflared:2026.10.3' } }).images.worca).toBe(
      'registry.example.com:5000/acme/worca',
    );
  });

  it('turns into wrangler vars, leaving unset settings out', () => {
    const { control, gate } = wranglerVars(parsePlatformConfig(minimal), 'prod');
    expect(control).toEqual({
      ENVIRONMENT: 'prod',
      APP_ORIGIN: 'https://app.example.com',
      INSTANCE_DOMAIN: 'example.net',
      INSTANCE_ORIGIN_SUFFIX: '',
      INSTANCE_SCHEME: 'https',
      COMPUTE_PROVIDER: 'railway',
      EDGE_PROVIDER: 'cloudflare',
      RESOURCE_PREFIX: 'acme-',
      EMAIL_FROM: 'Acme <no-reply@example.com>',
    });
    expect(gate).toEqual({
      ENVIRONMENT: 'prod',
      APP_ORIGIN: 'https://app.example.com',
      INSTANCE_DOMAIN: 'example.net',
      PASS_SECONDS: '60',
      IDLE_SECONDS: '86400',
      RECHECK_SECONDS: '3600',
      SCHEDULE_WAKE_LEAD_SECONDS: '600',
    });
  });

  it('lets an environment override the providers, and sends the apex to the about page by default', () => {
    const c = parsePlatformConfig({
      ...minimal,
      branding: { aboutUrl: 'https://example.com/about/' },
      environments: {
        prod: minimal.environments.prod!,
        dev: { appOrigin: 'http://app.localhost:8787', instanceDomain: 'run.localhost', local: true, providers: { compute: 'fake', edge: 'fake' } },
      },
    });
    const dev = wranglerVars(c, 'dev');
    expect(dev.control).toMatchObject({ LOCAL_DEV: '1', COMPUTE_PROVIDER: 'fake', EDGE_PROVIDER: 'fake', ABOUT_URL: 'https://example.com/about/' });
    expect(dev.gate.APEX_REDIRECT_URL).toBe('https://example.com/about/');
    expect(wranglerVars(c, 'prod').control.COMPUTE_PROVIDER).toBe('railway');
    expect(() => wranglerVars(parsePlatformConfig(minimal), 'dev')).toThrow(/no "dev" environment/);
  });

  it('sends the product and service names and the mail logo size to both Workers, as set', () => {
    const { control, gate } = wranglerVars(
      parsePlatformConfig({ ...minimal, branding: { productName: 'Acme Cloud', serviceName: 'Acme Workspaces', mailLogoSize: { width: 120, height: 40 }, abuseUrl: 'https://example.com/abuse' } }),
      'prod',
    );
    expect(control).toMatchObject({ PRODUCT_NAME: 'Acme Cloud', SERVICE_NAME: 'Acme Workspaces', MAIL_LOGO_SIZE: '120x40', ABUSE_URL: 'https://example.com/abuse' });
    expect(gate).toMatchObject({ PRODUCT_NAME: 'Acme Cloud', SERVICE_NAME: 'Acme Workspaces', ABUSE_URL: 'https://example.com/abuse' });
    expect(() => parsePlatformConfig({ ...minimal, branding: { mailLogoSize: { width: 2, height: 40 } } })).toThrow(/invalid platform config/);
  });

  it('definePlatform takes a gate logo as PNG bytes or a data: URI, and refuses anything else', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(definePlatform(minimal, { branding: { gateLogo: { mask: png } } }).branding.gateLogo).toEqual({ dataUri: 'data:image/png;base64,iVBORw==', aspect: '205/76' });
    expect(definePlatform(minimal).branding.gateLogo).toBeNull();
    expect(() => definePlatform(minimal, { branding: { gateLogo: { mask: 'https://example.com/logo.png' } } })).toThrow(/data:image\/png;base64/);
    expect(() => definePlatform(minimal, { branding: { gateLogo: { mask: png, aspect: 'wide' as `${number}/${number}` } } })).toThrow(/width\/height/);
  });

  it('definePlatform validates and registers the config for the isolate', () => {
    expect(() => definePlatform({ ...minimal, name: '' })).toThrow(/invalid platform config/);
    const d = definePlatform(minimal);
    expect(platform()).toBe(d);
    expect(d.config.name).toBe('acme');
  });
});

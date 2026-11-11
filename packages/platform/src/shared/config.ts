// Everything that differs between deployments of the platform, in one typed, validated object
// A deployment writes it once (worca.config.ts, from @worca/create-platform); the
// scaffolder turns it into the wrangler configs: names, routes and bindings, and the `vars` both
// Workers read through `Env` as before. So the Workers never parse this at runtime: `Env` stays
// the runtime interface, and this module is its single source. Code-level extensions (custom
// providers, from 2.2) go through definePlatform() in platform.ts.
//
// Imports nothing but zod, so node scripts (the scaffolder, checks) can load it directly.
import { z } from 'zod';

export const ENVIRONMENTS = ['dev', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** The Cloudflare resources a deployment names; `{env}` stands for the environment. */
export const NAME_KEYS = ['control', 'gate', 'database', 'instanceOps', 'keyRotation', 'newsletterSend'] as const;
export type NameKey = (typeof NAME_KEYS)[number];
const NAME_SUFFIX: Record<NameKey, string> = {
  control: 'control',
  gate: 'gate',
  database: 'db',
  instanceOps: 'instance-ops',
  keyRotation: 'key-rotation',
  newsletterSend: 'newsletter-send',
};

const prefix = z.string().regex(/^[a-z][a-z0-9-]{0,40}[a-z0-9]$/, 'lowercase letters, digits and dashes, starting with a letter');
const nameTemplate = z.string().regex(/^[a-z0-9{}-]{1,63}$/, 'a Worker/resource name; may contain {env}');
const host = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'a lowercase host name, no scheme or port');
const httpUrl = z.url({ protocol: /^https?$/ });
/** A URL without a path, as `new URL(x).origin` gives it. */
const origin = httpUrl.refine((u) => new URL(u).origin === u, 'an origin: scheme, host and port only, no trailing slash');
const email = z.email();
/** `Name <address>` or a bare address, as Resend takes it. */
const sender = z.string().regex(/^([^<>]+ <[^<>\s]+@[^<>\s]+>|[^<>\s]+@[^<>\s]+)$/, 'an address or "Name <address>"');
const image = z.string().regex(/^[a-z0-9][a-z0-9._\/-]*(:[0-9]+)?(\/[a-z0-9._-]+)*(:[A-Za-z0-9._-]+)?$/, 'an image reference');

/** Per-environment settings: domains and where things run. */
const environmentSchema = z
  .object({
    /** The control plane and console, e.g. https://app.example.com. */
    appOrigin: origin,
    /** Instances live at {slug}.{instanceDomain}. */
    instanceDomain: host,
    /** Where instanceDomain and www.instanceDomain redirect (D67); default: branding.aboutUrl, else appOrigin. */
    apexRedirectUrl: httpUrl.optional(),
    /** Website origins allowed to post to /api/public/* (newsletter, access requests). */
    publicFormOrigins: z.array(origin).default([]),
    /** Local development only: instances over http on a port (the gate's local port). */
    instanceScheme: z.enum(['http', 'https']).default('https'),
    instanceOriginSuffix: z.string().regex(/^(:\d{1,5})?$/).default(''),
    /** Under `wrangler dev` (sets LOCAL_DEV, which allows http and local hosts). */
    local: z.boolean().default(false),
    /** Overrides of the deployment-wide providers for this environment (e.g. fake in dev). */
    providers: z.lazy(() => providersSchema.partial()).optional(),
    /** The local stub instance server the fake compute provider talks to. */
    stubAdminUrl: httpUrl.optional(),
  })
  .strict();

const providersSchema = z
  .object({
    /** `railway`, `fake`, or the name of a provider registered with definePlatform (docs/providers.md). */
    compute: z.string().regex(/^[a-z][a-z0-9-]*$/),
    edge: z.enum(['cloudflare', 'fake']),
    /** The compute provider's region id for new instances; default: the provider's own default (Railway: europe-west4). */
    region: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  })
  .strict();

export const platformConfigSchema = z
  .object({
    /**
     * Name prefix of every Cloudflare resource ({name}-control-{env}, {name}-db-{env}, …) and of what
     * the providers create for instances ({name}-…: projects, tunnels; at most 19 characters).
     */
    name: prefix.refine((n) => n.length <= 19, 'at most 19 characters: instance resources are named {name}-…'),
    /** Overrides of single derived names; `{env}` is replaced by the environment. */
    names: z.partialRecord(z.enum(NAME_KEYS), nameTemplate).default({}),
    environments: z.partialRecord(z.enum(ENVIRONMENTS), environmentSchema).refine((e) => Object.keys(e).length > 0, 'at least one environment'),
    mail: z
      .object({
        /** Sender of account mail (sign-in codes, invitations, notices). */
        from: sender,
        /** Sender of newsletter mail; default: `from`. */
        newsletterFrom: sender.optional(),
        /** Postal address line in the newsletter footer; default: no line. */
        postalAddress: z.string().min(1).optional(),
        provider: z.literal('resend').default('resend'),
      })
      .strict(),
    providers: providersSchema.default({ compute: 'railway', edge: 'cloudflare' }),
    /** Who runs the deployment and where people read about it. Every field optional: unset, the link or line is left out. */
    branding: z
      .object({
        /**
         * The product name in page titles, the logo's text alternative and mail; default "Worca"
         * (the product being hosted). The logo, mark, favicon and colours come from the
         * deployment's branding/ folder (docs/branding.md).
         */
        productName: z.string().min(1).max(40).optional(),
        /** The hosted service in page footers; default "<productName> hosted". */
        serviceName: z.string().min(1).max(60).optional(),
        /** Pixel size the mail logo (branding/mail-logo-*.png) is shown at; default 148×44. */
        mailLogoSize: z.object({ width: z.number().int().min(16).max(600), height: z.number().int().min(16).max(200) }).strict().optional(),
        /** Shown as the sender in mail footers, e.g. "Example Hosting Ltd". */
        operatorName: z.string().min(1).optional(),
        /** The operator's website; mail footers link it, and public pages send people there. */
        websiteUrl: httpUrl.optional(),
        /** "What is this?" on sign-in and gate pages; default: websiteUrl, else the app. */
        aboutUrl: httpUrl.optional(),
        contactEmail: email.optional(),
        /** Where abuse reports go; default: contactEmail. */
        abuseEmail: email.optional(),
        /** An abuse report form, linked from the page of an instance stopped for abuse. */
        abuseUrl: httpUrl.optional(),
        privacyUrl: httpUrl.optional(),
        termsUrl: httpUrl.optional(),
        legalUrl: httpUrl.optional(),
      })
      .strict()
      .default({}),
    /** Gate timings (D27, D44, D56), in seconds. */
    gate: z
      .object({
        passSeconds: z.int().positive().default(60),
        idleSeconds: z.int().positive().default(86400),
        recheckSeconds: z.int().positive().default(3600),
        scheduleWakeLeadSeconds: z.int().positive().default(600),
      })
      .strict()
      .default({ passSeconds: 60, idleSeconds: 86400, recheckSeconds: 3600, scheduleWakeLeadSeconds: 600 }),
    /**
     * Optional modules, all off unless turned on. A module that is
     * off answers 404 on its routes and pages, sends no mail of its own and is not shown in the
     * console; its tables exist and stay empty, so turning it on later needs no migration.
     * Turnstile, the release hook's secret and the Google / Microsoft / SSO sign-ins stay switched
     * by their secrets and client IDs.
     */
    features: z
      .object({
        /** D70: the newsletter (subscribe forms, account card, release mail, the release hook). */
        newsletter: z.boolean().default(false),
        /** D69: the website's access-request form and the superadmins' review of it. */
        accessRequests: z.boolean().default(false),
        /**
         * D33, D78: tiers (plans) with instance and member limits and compute sizes, edited in the
         * console. Off: every org may have any number of instances and members on any size.
         */
        tiers: z.boolean().default(false),
      })
      .strict()
      .default({ newsletter: false, accessRequests: false, tiers: false }),
    /**
     * Where Cloudflare keeps the D1 database, set when `setup` creates it (existing databases are not
     * moved). `jurisdiction` keeps the data inside it (`eu`, `fedramp`); `location` is only a hint
     * (`weur`, `eeur`, `apac`, `oc`, `wnam`, `enam`). Use one or neither; default: Cloudflare picks.
     */
    database: z
      .object({
        jurisdiction: z.enum(['eu', 'fedramp']).optional(),
        location: z.enum(['weur', 'eeur', 'apac', 'oc', 'wnam', 'enam']).optional(),
      })
      .strict()
      .refine((d) => !(d.jurisdiction && d.location), 'set jurisdiction or location, not both')
      .default({}),
    /** Instance images; defaults are the public worca image and the pinned cloudflared. */
    images: z
      .object({
        /** worca and its broker: one image, tagged by worca version. */
        worca: image.refine((s) => !/:[^/]*$/.test(s), 'a repository without a tag').optional(),
        /** cloudflared, with its tag. */
        cloudflared: image.refine((s) => /:[^/]+$/.test(s), 'an image with a tag').optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type PlatformConfigInput = z.input<typeof platformConfigSchema>;
export type PlatformConfig = z.output<typeof platformConfigSchema>;
export type EnvironmentConfig = z.output<typeof environmentSchema>;

/** Validates a deployment's config; throws a readable error listing every problem. */
export function parsePlatformConfig(input: unknown): PlatformConfig {
  const r = platformConfigSchema.safeParse(input);
  if (!r.success) throw new Error(`invalid platform config:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/** The Cloudflare names of one environment: {name}-{suffix}-{env} unless overridden. */
export function resourceNames(config: PlatformConfig, env: Environment): Record<NameKey, string> {
  const out = {} as Record<NameKey, string>;
  for (const key of NAME_KEYS) {
    const template = config.names[key] ?? `${config.name}-${NAME_SUFFIX[key]}-{env}`;
    out[key] = template.replaceAll('{env}', env);
  }
  return out;
}

function environment(config: PlatformConfig, env: Environment): EnvironmentConfig {
  const e = config.environments[env];
  if (!e) throw new Error(`the platform config has no "${env}" environment`);
  return e;
}

/** The modules a deployment turns on, in a fixed order, as the FEATURES var; unset when none is on. */
export const FEATURE_NAMES = ['newsletter', 'accessRequests', 'tiers'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
function enabledFeatureList(config: PlatformConfig): string | undefined {
  const on = FEATURE_NAMES.filter((f) => config.features[f]);
  return on.length ? on.join(',') : undefined;
}

type Vars = Record<string, string>;

/** Adds the entries whose value is set; unset settings are left out of `vars` (the code's default applies). */
function set(vars: Vars, entries: Record<string, string | undefined>): Vars {
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) vars[k] = v;
  return vars;
}

/**
 * The wrangler `vars` of both Workers for one environment, exactly what each Worker's `Env`
 * reads. Settings that are unset stay out, so the code's own default applies.
 */
export function wranglerVars(config: PlatformConfig, env: Environment): { control: Vars; gate: Vars } {
  const e = environment(config, env);
  const b = config.branding;
  const providers = { ...config.providers, ...e.providers };
  const apex = e.apexRedirectUrl ?? b.aboutUrl;
  const common = {
    ENVIRONMENT: env,
    LOCAL_DEV: e.local ? '1' : undefined,
    APP_ORIGIN: e.appOrigin,
    INSTANCE_DOMAIN: e.instanceDomain,
  };
  const control = set(
    {},
    {
      ...common,
      INSTANCE_ORIGIN_SUFFIX: e.instanceOriginSuffix,
      INSTANCE_SCHEME: e.instanceScheme,
      COMPUTE_PROVIDER: providers.compute,
      EDGE_PROVIDER: providers.edge,
      COMPUTE_REGION: providers.region,
      RESOURCE_PREFIX: `${config.name}-`,
      STUB_ADMIN_URL: e.stubAdminUrl,
      EMAIL_FROM: config.mail.from,
      NEWSLETTER_FROM: config.mail.newsletterFrom,
      NEWSLETTER_POSTAL_ADDRESS: config.mail.postalAddress,
      PUBLIC_FORM_ORIGINS: e.publicFormOrigins.length ? e.publicFormOrigins.join(',') : undefined,
      PRODUCT_NAME: b.productName,
      SERVICE_NAME: b.serviceName,
      MAIL_LOGO_SIZE: b.mailLogoSize ? `${b.mailLogoSize.width}x${b.mailLogoSize.height}` : undefined,
      OPERATOR_NAME: b.operatorName,
      WEBSITE_URL: b.websiteUrl,
      ABOUT_URL: b.aboutUrl,
      CONTACT_EMAIL: b.contactEmail,
      ABUSE_EMAIL: b.abuseEmail,
      ABUSE_URL: b.abuseUrl,
      PRIVACY_URL: b.privacyUrl,
      TERMS_URL: b.termsUrl,
      LEGAL_URL: b.legalUrl,
      FEATURES: enabledFeatureList(config),
      WORCA_IMAGE: config.images.worca,
      CLOUDFLARED_IMAGE: config.images.cloudflared,
    },
  );
  const gate = set(
    {},
    {
      ...common,
      APEX_REDIRECT_URL: apex,
      PRODUCT_NAME: b.productName,
      SERVICE_NAME: b.serviceName,
      ABOUT_URL: b.aboutUrl,
      CONTACT_EMAIL: b.contactEmail,
      ABUSE_EMAIL: b.abuseEmail,
      ABUSE_URL: b.abuseUrl,
      PASS_SECONDS: String(config.gate.passSeconds),
      IDLE_SECONDS: String(config.gate.idleSeconds),
      RECHECK_SECONDS: String(config.gate.recheckSeconds),
      SCHEDULE_WAKE_LEAD_SECONDS: String(config.gate.scheduleWakeLeadSeconds),
    },
  );
  return { control, gate };
}

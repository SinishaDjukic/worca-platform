import type { GateRpcApi } from '../shared/contracts';
import type { SiteVars } from '../shared/site';

/** Bindings, vars and secrets of the control plane Worker (wrangler.control.jsonc, .dev.vars). */
export interface Env extends SiteVars {
  DB: D1Database;
  KV: KVNamespace;
  GATE: Service<GateRpcApi & Rpc.WorkerEntrypointBranded> & GateRpcApi;
  INSTANCE_OPS: Workflow;
  KEY_ROTATION?: Workflow; // org key re-encryption (keys-workflow.ts, D38)
  NEWSLETTER_SEND?: Workflow; // newsletter issues, batch by batch (newsletter/workflow.ts, D70)
  ASSETS?: Fetcher; // the web UI's static files (ui/, served by ui.ts)

  ENVIRONMENT: 'dev' | 'prod';
  LOCAL_DEV?: string; // "1" only under wrangler dev
  APP_ORIGIN: string; // https://app.example.com
  INSTANCE_DOMAIN: string; // example.net: instances at {slug}.example.net
  INSTANCE_ORIGIN_SUFFIX: string; // ":8798" locally, "" in prod
  INSTANCE_SCHEME: 'http' | 'https';
  COMPUTE_PROVIDER: string; // railway, fake, or a provider registered with definePlatform (providers/index.ts)
  EDGE_PROVIDER: 'fake' | 'cloudflare';
  COMPUTE_REGION?: string; // the compute provider's region id for new instances; unset: its default region
  RESOURCE_PREFIX?: string; // name prefix of what the providers create, `{name}-` (providers/prefix.ts)
  STUB_ADMIN_URL?: string; // fake provider: the local stub instance server
  EMAIL_FROM: string;
  RELEASE_IMAGE_CHECK?: string; // "off" only from scripts/dev.mjs: the local stack runs no images
  PUBLIC_FORM_ORIGINS?: string; // comma-separated website origins allowed to post to /api/public/* (https://example.com)
  NEWSLETTER_FROM?: string; // sender of newsletter mail; unset: EMAIL_FROM
  NEWSLETTER_POSTAL_ADDRESS?: string; // postal address line in the newsletter footer; unset: no line
  FEATURES?: string; // the optional modules that are on, comma-separated (features.ts); unset: none
  // Operator and links (SiteVars, src/shared/site.ts): OPERATOR_NAME, WEBSITE_URL, ABOUT_URL,
  // CONTACT_EMAIL, ABUSE_EMAIL, ABUSE_URL, PRIVACY_URL, TERMS_URL, LEGAL_URL; all optional.
  WORCA_IMAGE?: string; // repository of the worca and broker image, no tag; unset: images.ts default
  CLOUDFLARED_IMAGE?: string; // cloudflared with its tag; unset: images.ts default

  // Secrets
  BETTER_AUTH_SECRET: string;
  MASTER_KEY: string; // base64, 32 bytes (D37)
  MASTER_KEY_PREVIOUS?: string; // the old master key, only while a master rotation runs (keys.ts)
  BLIND_INDEX_KEY: string; // base64, 32 bytes, separate from the master key
  IDENTITY_SIGNING_JWK: string; // private ES256 JWK (JSON) for identity tokens
  RESEND_API_KEY?: string; // unset locally: mail is captured in KV
  RESEND_WEBHOOK_SECRET?: string; // whsec_...: Svix secret of the Resend webhook (S2); unset: endpoint 404s
  TURNSTILE_SECRET?: string; // unset: Turnstile off
  TURNSTILE_SITE_KEY?: string; // public; shown on the sign-in page when Turnstile is on
  TURNSTILE_BYPASS_TOKEN?: string; // smoke tests: x-turnstile-bypass skips the check (32+ chars; unset = never)
  SETUP_TOKEN?: string; // one-time first-superadmin bootstrap
  RELEASE_HOOK_SECRET?: string; // HMAC secret worca-cc's release workflow signs /api/hooks/release with; unset: 404
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  RAILWAY_TOKEN?: string; // railway compute provider
  RAILWAY_WORKSPACE_ID?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string; // the zone of INSTANCE_DOMAIN

  TEST_MIGRATIONS?: unknown; // unit tests only
}

/** Hono variables set by the session middleware (src/control/auth/middleware.ts). */
export interface SessionUser {
  id: string;
  email: string; // decrypted
  name: string; // decrypted
  status: 'pending' | 'active' | 'disabled';
}
export interface SessionInfo {
  id: string; // control-plane session id (cpSessionId)
  userId: string;
  method: 'email-otp' | 'passkey' | 'google' | 'microsoft' | 'sso';
  mfa: boolean; // passkey counts as MFA (D24)
  ssoOrgId: string | null; // org whose SSO provider created the session; 'sso' counts only there
  expiresAt: number; // unix ms
  activeOrganizationId: string | null;
}

export type AppContext = {
  Bindings: Env;
  Variables: { user: SessionUser | null; session: SessionInfo | null; requestId: string };
};

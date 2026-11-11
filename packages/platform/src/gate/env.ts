import type { ControlRpcApi } from '../shared/contracts';
import type { SiteVars } from '../shared/site';

/** SiteVars: ABOUT_URL, CONTACT_EMAIL, ABUSE_EMAIL, ABUSE_URL for the gate's own pages. */
export interface Env extends SiteVars {
  HOSTS: KVNamespace; // hostname -> HostEntry (D43, D53)
  GATE_OBJECT: DurableObjectNamespace; // one gate object per instance, EU jurisdiction in prod
  CONTROL: Service<ControlRpcApi & Rpc.WorkerEntrypointBranded> & ControlRpcApi;

  ENVIRONMENT: 'dev' | 'prod';
  LOCAL_DEV?: string;
  APP_ORIGIN: string;
  INSTANCE_DOMAIN: string;
  APEX_REDIRECT_URL?: string; // D67: where INSTANCE_DOMAIN and www.INSTANCE_DOMAIN redirect (301)
  PASS_SECONDS: string; // D44, default 60
  IDLE_SECONDS?: string; // D27, default 86400
  RECHECK_SECONDS?: string; // not suspendable yet: retry after, default 3600
  SCHEDULE_WAKE_LEAD_SECONDS?: string; // D56, default 600

  GATE_COOKIE_KEY: string; // secret: base64, 32 bytes; encrypts and signs the gate cookie
  IDENTITY_JWKS?: string; // not needed by the gate; tokens come from the control plane
}

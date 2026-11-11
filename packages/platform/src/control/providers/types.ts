// Provider interfaces the provisioning Workflows drive (architecture.md "Creating an instance",
// instance-lifecycle.md, docs/providers.md). `fake` implementations run locally against
// stub/instance.mjs; `railway` and `cloudflare` are the built-in real ones. A deployment adds its own
// compute provider with definePlatform (shared/platform.ts) and picks it by name in its config.
import type { Env } from '../env';
import type { Fetch, ProviderOptions } from './http';
import type { SettingsDeclaration, SettingValues } from './settings';

/** An instance's three services (worca-cc docs/instance-contract.md). */
export type ServiceKind = 'worca' | 'broker' | 'cloudflared';
/** Deploy order: cloudflared last, so the tunnel only connects once its origins exist. */
export const SERVICE_KINDS: readonly ServiceKind[] = ['worca', 'broker', 'cloudflared'];

export interface InstanceSpec {
  instanceId: string;
  orgId: string;
  host: string; // {slug}.INSTANCE_DOMAIN
  keyHost: string; // {key-slug}.INSTANCE_DOMAIN
  region: string; // the provider's region id (COMPUTE_REGION, else ComputeProviderInfo.defaultRegion)
  cpu: number; // the worca service's vCPU ceiling: the instance's compute size (D78)
  memoryMb: number; // the worca service's memory ceiling (the broker and tunnel keep the provider's own)
  volumeGb: number;
  image: { worca: string; broker: string; cloudflared: string };
  /** The instance's provider settings (info.settings.instance): defaults, then what its admins saved. */
  settings?: SettingValues;
}

/** Variables set on the instance's services (architecture.md step 4). */
export interface InstanceVariables {
  tunnelToken: string;
  allowedHosts: string; // exact host only (W2)
  identityIssuer: string; // APP_ORIGIN
  identityAudience: string; // host
  keyPageAudience: string; // keyHost
  heartbeatUrl: string; // APP_ORIGIN/api/heartbeat
  heartbeatCredential: string; // plaintext, only ever sent to the instance
  egress: EgressVariables; // outbound network policy (D73)
  // Credential broker in multi mode (D68). Both secrets are generated per instance by the create
  // Workflow and exist only in the instance's variables at the provider: never in D1, never in logs.
  brokerSecret: string; // shared by worca and the broker, 32+ characters
  brokerVaultKey: string; // 32 random bytes, base64; encrypts people's keys on the broker's volume
  instanceUrl: string; // https://{host}: the key page's "Back to worca" link
  keyPageUrl: string; // https://{keyHost}: the broker's public origin
  // Remote access in worca (D72): what remote mode turns off, turned back on by a tenant admin.
  terminalRemote: boolean; // WORCA_TERMINAL_REMOTE
  actionsRemote: boolean; // WORCA_ACTIONS_REMOTE
  size: WorcaSize; // D78: the worca service's ceiling and worca's parallelism
  ghAsPerson?: 'prefer'; // D79: see WorcaSettings
}

/**
 * The instance's compute size (D78) as the worca service gets it: its vCPU and memory ceiling, and
 * WORCA_MAX_PARALLEL / WORCA_MAX_PARALLEL_SCRIPTS.
 */
export interface WorcaSize {
  cpu: number;
  memoryMb: number;
  maxParallel: number;
  maxParallelScripts: number;
}

/**
 * What a rotation renews (D74): the tunnel token, the broker's shared secret and the heartbeat
 * credential. The vault key is not among them: it only decrypts the broker's volume, and a new one
 * would make every stored provider key unreadable.
 */
export type RotatedSecrets = Pick<InstanceVariables, 'tunnelToken' | 'brokerSecret' | 'heartbeatCredential'>;

/** The two remote-access switches (D72), set on the worca service only. */
export type RemoteAccess = Pick<InstanceVariables, 'terminalRemote' | 'actionsRemote'>;

/**
 * The effective outbound network policy (D73) as the worca service gets it: WORCA_EGRESS_MODE,
 * WORCA_EGRESS_ALLOW and WORCA_EGRESS_DENY, lists comma-separated in worca's form (`.example.com`
 * for every subdomain). Rendered by instances/egress.ts egressVariables.
 */
export interface EgressVariables {
  mode: 'open' | 'block' | 'allow';
  allow: string;
  deny: string;
}

/**
 * Git credentials (D79) as the services get them: the variables to set on the worca service and on
 * the broker (instances/git.ts gitVariables). Every other name in WORCA_GIT_VARIABLES /
 * BROKER_GIT_VARIABLES is removed. Values include secrets: never logged, never in step results.
 */
export interface GitVariables {
  worca: Record<string, string>;
  broker: Record<string, string>;
}

/** What a tenant admin changes on a running instance's worca service (D72, D73, D78): the reconfigure op applies all of it. */
export type WorcaSettings = RemoteAccess & {
  egress: EgressVariables;
  size: WorcaSize;
  /**
   * D79: WORCA_GH_AS_PERSON for an instance whose git settings nobody saved yet (git_version 0):
   * members' own GitHub tokens are used for their pushes and pull requests by default. Once a tenant
   * admin saves git settings, setGitSettings manages it instead and this is left out.
   */
  ghAsPerson?: 'prefer';
};

/**
 * Where the instance's services run at the provider, as the create step returned it and the
 * instance row keeps it (compute_ref). `projectId` is whatever the provider groups one instance's
 * services under; the other ids are the provider's own.
 */
export interface ComputeRef {
  projectId: string;
  services: Record<ServiceKind, { serviceId: string; deploymentId?: string }>;
  environmentId?: string;
  /**
   * The instance's provider settings (info.settings.instance), attached when the ref is read from
   * the instance row (parseComputeRef) and never stored with it. Absent where the caller read only
   * the ref (the status cron).
   */
  settings?: SettingValues;
}

/**
 * A compute size (D78): the worca service's vCPU and memory ceiling plus worca's parallelism
 * (WORCA_MAX_PARALLEL, WORCA_MAX_PARALLEL_SCRIPTS). A provider lists the ones it offers.
 */
export interface ComputeSize {
  id: string;
  name: string;
  vcpu: number;
  /** Memory ceiling in binary MB (4096 = 4 GB). */
  memoryMb: number;
  /** WORCA_MAX_PARALLEL: agents at once (worca's default is 4). */
  maxParallel: number;
  /** WORCA_MAX_PARALLEL_SCRIPTS: scripts at once (worca's default is 2). */
  maxParallelScripts: number;
}

/** A region the provider reports instances in. A reported id matches `id` exactly or as `{id}-…`. */
export interface ComputeRegion {
  id: string;
  label: string;
  /** D6: whether it is in the EU (the consoles flag instances outside it). */
  eu: boolean;
}

/**
 * What a compute provider is, without calling it: the consoles, the tier editor and the egress
 * rules read this, never the provider's API.
 */
export interface ComputeProviderInfo {
  /** Shown wherever the consoles name the provider ("Railway"). */
  displayName: string;
  /** D78: the sizes it offers, smallest first. Ids are stored on instances and tiers: never change what one means. */
  sizes: readonly ComputeSize[];
  /** The size of an instance created before sizes existed, and of a tier that lists none. */
  defaultSize: string;
  /** D6: where instances are created unless the config's providers.region (COMPUTE_REGION) says otherwise. */
  defaultRegion: string;
  /** Labels for the region ids it reports (ComputeFacts.region). */
  regions: readonly ComputeRegion[];
  /**
   * D78: a limit on what one account holds, shown on the console overview before it runs out
   * (Railway: services per workspace, three per instance). Null when the provider has none.
   */
  capacity: { unit: string; perInstance: number; limit: number } | null;
  /**
   * D73: who enforces the outbound network policy. 'worca': it is sent as WORCA_EGRESS_* and Worca
   * enforces it (the provider has no network policy of its own). 'provider': the provider enforces
   * it as well. Shown to platform staff.
   */
  egressEnforcement: 'worca' | 'provider';
  /**
   * The host a service answers at on the instance's private network: where worca reaches the
   * broker, and where the tunnel's cloudflared reaches worca and the broker's key page.
   */
  serviceHost(prefix: string, kind: ServiceKind): string;
  /**
   * Settings the console shows and the platform stores for it (providers/settings.ts): fields a
   * superadmin sets once (`deployment`), and fields tenant admins set per instance (`instance`).
   */
  settings?: SettingsDeclaration;
}

/** What a provider's API needs, handed to its factory. */
export interface ProviderContext {
  env: Env;
  fetch: Fetch;
  /** Name prefix of everything it creates (prefix.ts); only ever touch what carries it. */
  resourcePrefix: string;
  /** The deployment's provider settings (info.settings.deployment): defaults, then what a superadmin saved. */
  settings: SettingValues;
  options?: ProviderOptions;
}

/** P12: the provider account's plan and usage for the system page; read-only, one or two requests. */
export interface ProviderUsage {
  plan: string | null;
  /** e.g. { label: 'projects', used: 12, limit: 100 }; null where the provider didn't say. */
  items: { label: string; used: number | null; limit: number | null }[];
  /** The provider's own answer, shown as is to platform staff. */
  details?: unknown;
}

/** A compute provider as a deployment registers it (definePlatform) or the platform builds it in. */
export interface ComputeProviderDefinition {
  info: ComputeProviderInfo;
  create(ctx: ProviderContext): ComputeProvider;
  /** What is missing for it to work (secret or setting names), for the system page's "not configured". Empty: configured. */
  missingConfig?(ctx: ProviderContext): string[];
  usage?(ctx: ProviderContext): Promise<ProviderUsage>;
}

export interface ComputeProvider {
  /** The name it is registered under (COMPUTE_PROVIDER). */
  readonly name: string;
  createProject(spec: InstanceSpec): Promise<ComputeRef>;
  setVariables(ref: ComputeRef, vars: InstanceVariables): Promise<void>;
  /**
   * Deploys (or redeploys) every service with the given worca version's images; with `kinds`, only
   * those services (a component refresh, D76), the others left running as they are.
   */
  deploy(ref: ComputeRef, image: InstanceSpec['image'], kinds?: readonly (keyof ComputeRef['services'])[]): Promise<ComputeRef>;
  /**
   * D48: deploymentStop on each service's latest deployment. Resolves only once the provider
   * confirms nothing runs any more; throws when that doesn't happen in time (the step retries).
   */
  stop(ref: ComputeRef): Promise<void>;
  /**
   * D48: deploymentRedeploy of each service. `worcaFromConfig`: worca is deployed from its current
   * configuration instead (as restartWorca does), so variables changed while it was down apply;
   * `brokerFromConfig` likewise for the broker (D79: its GitHub sign-in changed).
   * `images` (D76): these services get the new image and a deployment of it, not a redeploy of the
   * one that ran before (which would bring the old image back).
   */
  start(ref: ComputeRef, opts?: { worcaFromConfig?: boolean; brokerFromConfig?: boolean; images?: Partial<InstanceSpec['image']> }): Promise<ComputeRef>;
  /**
   * D72, D73: sets the tenant-admin settings on the worca service only, without deploying:
   * WORCA_TERMINAL_REMOTE, WORCA_ACTIONS_REMOTE, WORCA_EGRESS_MODE / _ALLOW / _DENY in one write,
   * removes the WORCA_EGRESS_ALLOWLIST earlier instances were created with, and resolves only once
   * the provider confirms it holds exactly these values (throws otherwise). Nothing else changes:
   * the other variables (secrets among them) are left as they are.
   */
  setWorcaSettings(ref: ComputeRef, settings: WorcaSettings): Promise<void>;
  /**
   * D73: whether the worca deployment in `ref` (from restartWorca) runs: 'starting' while it builds
   * or deploys, 'failed' when it never will (a provider that keeps the previous deployment running
   * then runs it with the previous variables).
   */
  worcaDeploymentState(ref: ComputeRef): Promise<'running' | 'starting' | 'failed'>;
  /** D72: a new deployment of the worca service from its current configuration (same image, current variables). */
  restartWorca(ref: ComputeRef): Promise<ComputeRef>;
  /**
   * D79: sets the git variables on the worca service and the broker without deploying, removes
   * every other managed git variable, and resolves only once the provider confirms it holds exactly
   * these (throws naming the variables, never their values). Deploys nothing: whether the broker
   * restarts is the operation's call (git_broker_applied).
   */
  setGitSettings(ref: ComputeRef, git: GitVariables): Promise<void>;
  /** D79: a new deployment of the broker from its current configuration (the key page restarts; worca keeps running). */
  restartBroker(ref: ComputeRef): Promise<ComputeRef>;
  /**
   * D74: writes the renewed secrets to the services that hold them, without deploying, and
   * resolves only once the provider confirms it holds them (throws naming the variables, never
   * their values). Every other variable stays as it is.
   */
  setSecrets(ref: ComputeRef, secrets: RotatedSecrets): Promise<void>;
  /** D74: a new deployment of every service from its current configuration (same images, current variables). */
  restartServices(ref: ComputeRef): Promise<ComputeRef>;
  /** Deletes the project and its volumes. Only the project id is needed. */
  destroy(ref: Pick<ComputeRef, 'projectId'>): Promise<void>;
  /**
   * The instance's project found by its name, for a delete whose create never saved the compute
   * ref (it failed half-way after the project was made). Null when there is none.
   */
  findProject(instanceId: string): Promise<Pick<ComputeRef, 'projectId'> | null>;
  /**
   * P1, read-only: the latest deployment status of each service, by project id. Called by the
   * 5-minute cron with every instance's ref; answer in as few requests as the provider allows
   * (Railway: one query for the whole workspace).
   */
  deploymentStatuses(refs: ComputeRef[]): Promise<Record<string, ProjectStatus>>;
  /**
   * Read-only: what the instance really runs on, as the provider reports it (not the tier's
   * intended size). Called for a few instances per cron tick; one request each if possible.
   */
  describe(ref: ComputeRef): Promise<ComputeFacts>;
}

/**
 * One service's resources. cpu: vCPU ceiling; memoryMb: memory ceiling in decimal MB (4 GB = 4000);
 * volumeMb: the volume's size, null without a volume; volumeUsedMb: how much of it is used. Null
 * where the provider didn't say.
 */
export interface ServiceFacts {
  cpu: number | null;
  memoryMb: number | null;
  volumeMb: number | null;
  volumeUsedMb?: number | null;
}

export interface ComputeFacts {
  /** Provider region id the worca service's latest deployment was placed in, e.g. `sfo`, `europe-west4-drams3a`. */
  region: string | null;
  services: Record<ServiceKind, ServiceFacts>;
}

/**
 * A service's latest deployment as the provider reports it. `state` is what the consoles go by;
 * `status` is the provider's own word for it, shown as is (Railway: SUCCESS, CRASHED, …).
 */
export interface ServiceStatus {
  /** running, starting (building or deploying), stopped (nothing of it runs) or failed; null without a deployment. */
  state?: ServiceState | null;
  status: string | null;
  statusUpdatedAt: string | null;
  /**
   * Nothing of the latest deployment runs (a provider's status may stay "success" after a stop, as
   * Railway's does). Null when unknown (no deployment, or a cache written before the field existed).
   */
  stopped?: boolean | null;
}
export type ServiceState = 'running' | 'starting' | 'stopped' | 'failed';
export type ProjectStatus = Partial<Record<ServiceKind, ServiceStatus>>;

/** Cloudflare tunnel status. */
export type TunnelStatus = 'healthy' | 'degraded' | 'down' | 'inactive';

export interface EdgeRef {
  tunnelId: string;
  dnsRecordIds: string[];
}

/**
 * Where the tunnel sends each host: origins on the instance's private network, from the compute
 * provider (ComputeProviderInfo.serviceHost). The broker's private API port is never routed.
 */
export interface TunnelOrigins {
  worca: string; // http://{worca host}:4317
  keyPage: string; // http://{broker host}:8081
}

export interface EdgeProvider {
  readonly name: 'fake' | 'cloudflare';
  /** D5: one tunnel per instance, ingress for both hosts to the instance's services. */
  createTunnel(spec: InstanceSpec, origins: TunnelOrigins): Promise<{ tunnelId: string; tunnelToken: string }>;
  /** Proxied CNAMEs for both hosts pointing at the tunnel (D51: no Workers VPC). */
  addDns(spec: InstanceSpec, tunnelId: string): Promise<string[]>;
  deleteDns(recordIds: string[]): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
  /**
   * D74: a new secret for the instance's tunnel, and every open connection dropped, so nothing
   * holding the token issued before stays connected or can reconnect. Returns the new token.
   */
  rotateTunnelSecret(tunnelId: string): Promise<string>;
  /**
   * The instance's tunnel (by name) and DNS records (by host, with our comment for this instance),
   * for a delete whose create never saved them. Empty fields when there are none.
   */
  findEdge(instanceId: string, hosts: string[]): Promise<EdgeRef | null>;
  /**
   * D76, read-only: the cloudflared version each connection of the tunnel reports (one entry per
   * connection, empty when nothing is connected). Null when the provider can't tell (fake).
   */
  connectorVersions(tunnelId: string): Promise<string[] | null>;
  /** P1, read-only: status by tunnel id; Cloudflare lists every tunnel with our prefix in one call. */
  tunnelStatuses(tunnelIds: string[]): Promise<Record<string, TunnelStatus>>;
}

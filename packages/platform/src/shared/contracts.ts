// Contracts between the control plane, the gate and instances. Both Workers import this file;
// change it only together with both sides.

export type InstanceStatus = 'creating' | 'running' | 'suspended' | 'stopped' | 'upgrading' | 'deleting';

/** What the gate stores in KV per hostname (D43). Slugs never change, so this is safe to cache. */
export interface HostEntry {
  instanceId: string;
  /** `worca` for {slug}.INSTANCE_DOMAIN, `keypage` for the broker's {key-slug}.INSTANCE_DOMAIN (D9). */
  kind: 'worca' | 'keypage';
  /** Local development only: where the gate forwards instead of the hostname's own origin. */
  upstream?: string;
}

/** Claims of the identity token the gate attaches for worca (identity-and-access.md). */
export interface IdentityClaims {
  iss: string; // APP_ORIGIN
  aud: string; // the instance host, e.g. k7m2qz9xwp.example.net
  sub: string; // user id
  email: string;
  name: string;
  org: string; // org id
  inst: string; // instance id
  teams: string[]; // ids of the teams that grant this instance
  iat: number;
  exp: number;
}

/** Header the gate uses to hand the identity token to worca. */
export const IDENTITY_HEADER = 'x-worca-identity';

/** Paths the gate serves itself on every instance host. */
export const GATE_PATHS = {
  callback: '/.gate/callback',
  status: '/.gate/status',
  signout: '/.gate/signout',
} as const;

export interface CodeExchange {
  token: string;
  tokenExp: number; // unix seconds
  userId: string;
  cpSessionId: string; // control-plane session id (not its token)
  instanceId: string;
}

export interface TokenRenewal {
  token: string;
  tokenExp: number;
}

/** Heartbeat body an instance posts to APP_ORIGIN/api/heartbeat (D28, D56). */
export interface HeartbeatBody {
  health: 'ok' | 'degraded';
  version: string;
  pipelines: Record<string, number>; // counts by status, no ids or titles
  nextScheduledAt: number | null; // unix seconds
  suspendable: boolean;
}

/** What the gate object reports about itself (status page, tests, platform console). */
export interface GateState {
  instanceId: string;
  status: InstanceStatus | 'unknown';
  sessions: number;
  lastVisit: number | null; // unix ms
  suspendable: boolean | null;
  nextScheduledAt: number | null; // unix seconds
  waking: boolean;
  alarmAt: number | null; // unix ms
}

export type SessionFilter = { userId: string } | { cpSessionId: string } | { all: true };

/**
 * Called by the gate over its service binding to the control plane (D45).
 * Implemented by `ControlRpc` in src/control/rpc.ts.
 */
export interface ControlRpcApi {
  /** One-time sign-in code -> identity token. Null when unknown, used, expired or for another host. */
  exchangeCode(code: string, host: string): Promise<CodeExchange | null>;
  /** Re-checks the control-plane session, team access and login policy; null when access has ended. */
  renewToken(input: { cpSessionId: string; userId: string; host: string }): Promise<TokenRenewal | null>;
  /** The gate object's idle alarm fired and the instance is suspendable (D27). */
  requestSuspend(instanceId: string): Promise<void>;
  /** A visit or a schedule needs a suspended instance running again (D27, D56). */
  requestWake(instanceId: string, reason: 'visit' | 'schedule'): Promise<void>;
  /**
   * G1: how far a wake has got, for the gate's starting page: `starting` while the services are
   * redeployed, `waiting` until worca's first heartbeat; null when no wake is under way.
   */
  wakePhase(instanceId: string): Promise<WakePhase | null>;
}

export type WakePhase = 'starting' | 'waiting';

/**
 * Called by the control plane over its service binding to the gate.
 * Implemented by `GateRpc` in src/gate/rpc.ts.
 */
export interface GateRpcApi {
  putHost(host: string, entry: HostEntry): Promise<void>;
  deleteHost(host: string): Promise<void>;
  /**
   * `onlyFrom`: apply only when the gate object's current status is one of these. Heartbeats use
   * it to repair `creating` without ever overriding a stop, suspension or deletion that raced them.
   */
  setStatus(instanceId: string, status: InstanceStatus, onlyFrom?: InstanceStatus[]): Promise<void>;
  dropSessions(instanceId: string, filter: SessionFilter): Promise<number>;
  heartbeat(instanceId: string, beat: { suspendable: boolean; nextScheduledAt: number | null }): Promise<void>;
  /** Deletes the gate object's storage (instance deletion, step 4). */
  destroy(instanceId: string): Promise<void>;
  getState(instanceId: string): Promise<GateState>;
}

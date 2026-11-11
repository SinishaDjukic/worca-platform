// The instance contract (worca-cc docs/instance-contract.md) as environment variables: what each
// of an instance's three services gets, whatever runs them. A compute provider adds only what its
// own platform needs (Railway: RAILWAY_RUN_UID, the broker's PORT) and decides where the variables
// live. Kept here, not in a provider, so every provider sets the same contract.
import type { EgressVariables, InstanceVariables, RemoteAccess, RotatedSecrets, ServiceKind, WorcaSettings, WorcaSize } from './types';

/** worca's port; the tunnel's ingress names it. */
export const WORCA_PORT = 4317;
/** The broker's private API, which only worca calls; never routed by the tunnel. */
export const BROKER_PRIVATE_PORT = 8080;
/** The broker's key page, the only broker port the tunnel routes. */
export const BROKER_UI_PORT = 8081;
/** Where worca and the broker each mount their own volume. */
export const DATA_MOUNT_PATH = '/data';

// worca on a private network the tunnel reaches it over: `::` listens on IPv6 and IPv4. Without
// WORCA_DATA_DIR worca keeps its data outside the volume and loses it on every redeploy.
// WORCA_AUTO_RESUME (worca backlog B3) resumes runs a suspend, wake or upgrade paused (on by default in
// worca; 1 also resumes runs a crash interrupted); WORCA_AWAY_PER_PERSON (B4) makes "I'm away" apply
// to each person's own runs, since a team shares an instance (off by default in worca). Images older
// than the change ignore both.
const WORCA_FIXED = {
  WORCA_HOST: '::', PORT: String(WORCA_PORT), WORCA_DATA_DIR: DATA_MOUNT_PATH, WORCA_AUTO_RESUME: '1', WORCA_AWAY_PER_PERSON: '1',
} as const;

// The broker per worca's guide (credential-broker.md): multi mode, its own volume for the encrypted
// key store, IPv6.
const BROKER_FIXED = {
  WORCA_BROKER_MODE: 'multi',
  WORCA_BROKER_HOST: '::',
  WORCA_BROKER_PORT: String(BROKER_PRIVATE_PORT),
  WORCA_BROKER_UI_PORT: String(BROKER_UI_PORT),
  WORCA_BROKER_DATA_DIR: DATA_MOUNT_PATH,
} as const;

/**
 * Variables per service. `brokerHost`: the host name worca reaches the broker at on the instance's
 * private network (ComputeProviderInfo.serviceHost).
 *
 * | Service     | Variable                 | From InstanceVariables                     |
 * |-------------|--------------------------|--------------------------------------------|
 * | worca       | WORCA_HOST, PORT         | fixed: `::` and 4317                       |
 * | worca       | WORCA_DATA_DIR           | fixed: the volume's mount path             |
 * | worca       | WORCA_AUTO_RESUME        | fixed: 1 (B3)                              |
 * | worca       | WORCA_AWAY_PER_PERSON    | fixed: 1 (B4)                              |
 * | worca       | WORCA_ALLOWED_HOSTS      | allowedHosts (exact host only, W2)         |
 * | worca       | WORCA_IDENTITY_ISSUER    | identityIssuer (APP_ORIGIN, W1)            |
 * | worca       | WORCA_IDENTITY_AUDIENCE  | identityAudience (host)                    |
 * | worca       | WORCA_IDENTITY_JWKS_URL  | identityIssuer + /.well-known/jwks.json    |
 * | worca       | WORCA_HEARTBEAT_URL      | heartbeatUrl (W3)                          |
 * | worca       | WORCA_HEARTBEAT_TOKEN    | heartbeatCredential                        |
 * | worca       | WORCA_EGRESS_MODE        | egress.mode: open, block or allow (D73)    |
 * | worca       | WORCA_EGRESS_ALLOW       | egress.allow (D73)                         |
 * | worca       | WORCA_EGRESS_DENY        | egress.deny (D73)                          |
 * | worca       | WORCA_BROKER_URL         | http://{brokerHost}:8080                   |
 * | worca       | WORCA_BROKER_SECRET      | brokerSecret (D68)                         |
 * | worca       | WORCA_BROKER_REQUIRED    | fixed: 1 (refuse to start without broker)  |
 * | worca       | WORCA_TERMINAL_REMOTE    | terminalRemote: '1' on, '0' off (D72)      |
 * | worca       | WORCA_ACTIONS_REMOTE     | actionsRemote: '1' on, '0' off (D72)       |
 * | worca       | WORCA_MAX_PARALLEL       | size.maxParallel (D78)                     |
 * | worca       | WORCA_MAX_PARALLEL_SCRIPTS | size.maxParallelScripts (D78)            |
 * | worca       | WORCA_GH_AS_PERSON       | ghAsPerson, when set (D79)                 |
 * | broker      | WORCA_BROKER_MODE, _HOST, _PORT, _UI_PORT, _DATA_DIR | fixed (BROKER_FIXED) |
 * | broker      | WORCA_BROKER_SECRET      | brokerSecret (D68)                         |
 * | broker      | WORCA_BROKER_VAULT_KEY   | brokerVaultKey (D68)                       |
 * | broker      | WORCA_BROKER_PUBLIC_URL  | keyPageUrl                                 |
 * | broker      | WORCA_BROKER_RETURN_URL  | instanceUrl                                |
 * | broker      | WORCA_ALLOWED_HOSTS      | keyPageAudience (keyHost)                  |
 * | broker      | WORCA_IDENTITY_ISSUER    | identityIssuer                             |
 * | broker      | WORCA_IDENTITY_AUDIENCE  | keyPageAudience (keyHost)                  |
 * | broker      | WORCA_IDENTITY_JWKS_URL  | identityIssuer + /.well-known/jwks.json    |
 * | cloudflared | TUNNEL_TOKEN             | tunnelToken                                |
 *
 * The broker's key page shares worca's remote-access code (W1), hence the same names.
 * WORCA_TERMINAL_REMOTE and WORCA_ACTIONS_REMOTE are always set, '0' when off: worca counts only
 * 1/true/yes/on as on (isTruthy in worca's ui/server.mjs), so '0' is off and an upsert never
 * needs to delete a variable. The three WORCA_EGRESS_* variables are likewise always set and never
 * empty (egress.ts egressVariables), and so are the two WORCA_MAX_PARALLEL* ones (D78).
 * setWorcaSettings changes these later in one write (worcaSettingsVariables) and removes
 * WORCA_EGRESS_ALLOWLIST (the fixed list instances got before D73, never read by worca).
 */
export function instanceEnvironment(vars: InstanceVariables, brokerHost: string): Record<ServiceKind, Record<string, string>> {
  const jwksUrl = `${vars.identityIssuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
  return {
    worca: {
      ...WORCA_FIXED,
      WORCA_ALLOWED_HOSTS: vars.allowedHosts,
      WORCA_IDENTITY_ISSUER: vars.identityIssuer,
      WORCA_IDENTITY_AUDIENCE: vars.identityAudience,
      WORCA_IDENTITY_JWKS_URL: jwksUrl,
      WORCA_HEARTBEAT_URL: vars.heartbeatUrl,
      WORCA_HEARTBEAT_TOKEN: vars.heartbeatCredential,
      WORCA_BROKER_URL: `http://${brokerHost}:${BROKER_PRIVATE_PORT}`,
      WORCA_BROKER_SECRET: vars.brokerSecret,
      WORCA_BROKER_REQUIRED: '1',
      ...remoteAccessVariables(vars),
      ...egressEnv(vars.egress),
      ...sizeVariables(vars.size),
      ...ghAsPersonEnv(vars),
    },
    broker: {
      ...BROKER_FIXED,
      WORCA_BROKER_SECRET: vars.brokerSecret,
      WORCA_BROKER_VAULT_KEY: vars.brokerVaultKey,
      WORCA_BROKER_PUBLIC_URL: vars.keyPageUrl,
      WORCA_BROKER_RETURN_URL: vars.instanceUrl,
      WORCA_ALLOWED_HOSTS: vars.keyPageAudience,
      WORCA_IDENTITY_ISSUER: vars.identityIssuer,
      WORCA_IDENTITY_AUDIENCE: vars.keyPageAudience,
      WORCA_IDENTITY_JWKS_URL: jwksUrl,
    },
    cloudflared: { TUNNEL_TOKEN: vars.tunnelToken },
  };
}

/** The variables a rotation (D74) renews, per service, under the names instanceEnvironment sets them. */
export function rotatedVariables(secrets: RotatedSecrets): Record<ServiceKind, Record<string, string>> {
  return {
    worca: { WORCA_HEARTBEAT_TOKEN: secrets.heartbeatCredential, WORCA_BROKER_SECRET: secrets.brokerSecret },
    broker: { WORCA_BROKER_SECRET: secrets.brokerSecret },
    cloudflared: { TUNNEL_TOKEN: secrets.tunnelToken },
  };
}

/** D72: the worca service's two remote-access variables, '1' on and '0' off. */
export function remoteAccessVariables(access: RemoteAccess): Record<string, string> {
  return { WORCA_TERMINAL_REMOTE: access.terminalRemote ? '1' : '0', WORCA_ACTIONS_REMOTE: access.actionsRemote ? '1' : '0' };
}

/** D73: the worca service's outbound network policy variables, always all three (egress.ts egressVariables never renders an empty one). */
export function egressEnv(egress: EgressVariables): Record<string, string> {
  return { WORCA_EGRESS_MODE: egress.mode, WORCA_EGRESS_ALLOW: egress.allow, WORCA_EGRESS_DENY: egress.deny };
}

/** D79: pushes as the person who acted, until a tenant admin's git settings take over the variable. */
export function ghAsPersonEnv(s: Pick<WorcaSettings, 'ghAsPerson'>): Record<string, string> {
  return s.ghAsPerson ? { WORCA_GH_AS_PERSON: s.ghAsPerson } : {};
}

/** D78: worca's parallelism for the instance's compute size. */
export function sizeVariables(size: WorcaSize): Record<string, string> {
  return { WORCA_MAX_PARALLEL: String(size.maxParallel), WORCA_MAX_PARALLEL_SCRIPTS: String(size.maxParallelScripts) };
}

/** What setWorcaSettings writes on the worca service, in one write. */
export function worcaSettingsVariables(settings: WorcaSettings): Record<string, string> {
  return { ...remoteAccessVariables(settings), ...egressEnv(settings.egress), ...sizeVariables(settings.size), ...ghAsPersonEnv(settings) };
}

/** Before D73 every instance got this fixed list (worca never read it); setWorcaSettings removes it. */
export const LEGACY_EGRESS_VARIABLE = 'WORCA_EGRESS_ALLOWLIST';

/**
 * D79: what setGitSettings changes on one service: the variables to upsert (only those whose value
 * differs from what the service holds) and the managed names to delete (held, not wanted).
 */
export function gitDiff(held: Record<string, string>, want: Record<string, string>, managed: readonly string[]): { upsert: Record<string, string>; remove: string[] } {
  const upsert = Object.fromEntries(Object.entries(want).filter(([k, v]) => held[k] !== v));
  return { upsert, remove: managed.filter((k) => k in held && !(k in want)) };
}

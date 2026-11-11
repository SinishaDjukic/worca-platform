// The other modules identity calls (internal-apis.md), behind one seam so
// unit tests can replace them without a full tenancy/instances/keys setup.
import type { Env } from '../env';
import type { KeyRing } from '../keys-api';
import { getKeyRing } from '../keys';
import { checkInstanceAccess } from '../tenancy/policy';
import { findInstanceByHost } from '../instances/api';

export type AccessResult =
  | { ok: true; orgId: string; teamIds: string[] }
  | {
      ok: false;
      reason: 'not_found' | 'not_member' | 'no_team' | 'policy_method' | 'policy_domain' | 'disabled';
      requiredMethods?: string[];
    };

export interface InstanceRef {
  id: string;
  orgId: string;
  kind: 'worca' | 'keypage';
  status: string;
}

export interface IdentityDeps {
  checkInstanceAccess(env: Env, input: { userId: string; sessionMethod: string; instanceId: string; ssoOrgId?: string | null }): Promise<AccessResult>;
  findInstanceByHost(env: Env, host: string): Promise<InstanceRef | null>;
  getKeyRing(env: Env): KeyRing;
}

const defaults: IdentityDeps = {
  checkInstanceAccess,
  findInstanceByHost,
  getKeyRing,
};

let current: IdentityDeps = defaults;

export function deps(): IdentityDeps {
  return current;
}

/** Tests only: replace some dependencies; call with no argument to restore the defaults. */
export function setIdentityDeps(overrides?: Partial<IdentityDeps>): void {
  current = overrides ? { ...defaults, ...overrides } : defaults;
}

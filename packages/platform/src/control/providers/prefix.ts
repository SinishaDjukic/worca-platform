// The name prefix of everything the providers create for instances (projects, services, tunnels,
// DNS record comments), so ours are recognisable in a shared account and nothing else is ever
// touched. Generated from the platform config's `name` (`{name}-`) as the RESOURCE_PREFIX var.
import type { Env } from '../env';

export const DEFAULT_RESOURCE_PREFIX = 'worca-';
/** Room for the instance id in names with a length limit (Railway projects: 32 characters). */
export const RESOURCE_PREFIX_MAX = 20;

export function resourcePrefix(env: Pick<Env, 'RESOURCE_PREFIX'>): string {
  const prefix = env.RESOURCE_PREFIX || DEFAULT_RESOURCE_PREFIX;
  if (!/^[a-z][a-z0-9-]*-$/.test(prefix) || prefix.length > RESOURCE_PREFIX_MAX) {
    throw new Error(`RESOURCE_PREFIX must be lowercase letters, digits and dashes, end with a dash, and be at most ${RESOURCE_PREFIX_MAX} characters: ${prefix}`);
  }
  return prefix;
}

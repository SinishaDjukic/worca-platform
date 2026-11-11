// The provider registry: picks the compute and edge providers from COMPUTE_PROVIDER /
// EDGE_PROVIDER. Built in: compute `railway` and `fake`, edge `cloudflare` and `fake`. A
// deployment registers more compute providers with definePlatform (shared/platform.ts) and names
// one in its config (providers.compute); docs/providers.md.
import type { Env } from '../env';
import { platform } from '../../shared/platform';
import { createCloudflareEdge } from './cloudflare';
import { fakeCompute, createFakeEdge } from './fake';
import type { Fetch, ProviderOptions } from './http';
import { resourcePrefix } from './prefix';
import { effectiveSettings, storedValues, type SettingValues } from './settings';
import { railwayCompute } from './railway';
import { BROKER_UI_PORT, WORCA_PORT } from './instance-env';
import type { ComputeProvider, ComputeProviderDefinition, ComputeProviderInfo, EdgeProvider, ProviderContext, ServiceKind, TunnelOrigins } from './types';

export interface Providers {
  compute: ComputeProvider;
  edge: EdgeProvider;
}

export const BUILTIN_COMPUTE: Readonly<Record<string, ComputeProviderDefinition>> = { railway: railwayCompute, fake: fakeCompute };

/** The registered compute provider of this name: one from definePlatform first, then the built-ins. */
export function computeDefinition(name: string): ComputeProviderDefinition {
  const def = platform()?.providers.compute[name] ?? BUILTIN_COMPUTE[name];
  if (!def) throw new Error(`unknown COMPUTE_PROVIDER: ${name}`);
  return def;
}

/** Every compute provider name there is: the built-ins and those registered with definePlatform. */
export function computeProviderNames(): string[] {
  return [...Object.keys(BUILTIN_COMPUTE), ...Object.keys(platform()?.providers.compute ?? {})];
}

/** What the configured compute provider offers (sizes, regions, capacity …), without calling it. */
export function computeInfo(env: Pick<Env, 'COMPUTE_PROVIDER'>): ComputeProviderInfo {
  return computeDefinition(env.COMPUTE_PROVIDER).info;
}

/** The region new instances are created in: COMPUTE_REGION, else the provider's default. */
export function computeRegion(env: Pick<Env, 'COMPUTE_PROVIDER' | 'COMPUTE_REGION'>): string {
  return env.COMPUTE_REGION || computeInfo(env).defaultRegion;
}

/** The host a service of an instance answers at on its private network (ComputeProviderInfo.serviceHost). */
export function serviceHost(env: Pick<Env, 'COMPUTE_PROVIDER' | 'RESOURCE_PREFIX'>, kind: ServiceKind): string {
  return computeInfo(env).serviceHost(resourcePrefix(env), kind);
}

/** Where the tunnel sends an instance's two hosts: worca, and the broker's key page (never its private API). */
export function tunnelOrigins(env: Pick<Env, 'COMPUTE_PROVIDER' | 'RESOURCE_PREFIX'>): TunnelOrigins {
  return { worca: `http://${serviceHost(env, 'worca')}:${WORCA_PORT}`, keyPage: `http://${serviceHost(env, 'broker')}:${BROKER_UI_PORT}` };
}

// Wrapped so the global fetch is never called with a foreign `this`.
const bind = (f: typeof fetch): Fetch => (url, init) => f(url, init);

/** `settings`: the deployment's provider settings, effective (providers/settings.ts; loadDeploymentSettings). */
export function providerContext(env: Env, fetchImpl: typeof fetch = fetch, settings: SettingValues = {}, options?: ProviderOptions): ProviderContext {
  return { env, fetch: bind(fetchImpl), resourcePrefix: resourcePrefix(env), settings, options };
}

/**
 * Both providers. `settings`: the deployment's provider settings; without them the provider gets
 * its declared defaults only. Code that runs operations uses providersFor, which loads them.
 */
export function getProviders(env: Env, fetchImpl: typeof fetch = fetch, settings?: SettingValues): Providers {
  const def = computeDefinition(env.COMPUTE_PROVIDER);
  const ctx = providerContext(env, fetchImpl, settings ?? effectiveSettings(def.info.settings?.deployment, null));
  return { compute: def.create(ctx), edge: edgeFor(env, fetchImpl) };
}

/** Both providers with the deployment's saved provider settings. */
export async function providersFor(env: Env, fetchImpl: typeof fetch = fetch): Promise<Providers> {
  return getProviders(env, fetchImpl, await loadDeploymentSettings(env));
}

/** platform_settings key of the deployment's provider settings ({"provider", "values"}). */
export const DEPLOYMENT_SETTINGS_KEY = 'compute_settings';

/** What a superadmin saved for the configured provider (null: nothing, or saved for another one). */
export async function savedDeploymentSettings(env: Env): Promise<SettingValues | null> {
  const row = await env.DB.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(DEPLOYMENT_SETTINGS_KEY).first<{ value: string }>()
    .catch(() => null); // platform_settings not migrated yet (unit tests of single modules)
  return storedValues(row?.value, env.COMPUTE_PROVIDER);
}

/** The deployment's provider settings as the provider gets them: declared defaults, then what is saved. */
export async function loadDeploymentSettings(env: Env): Promise<SettingValues> {
  return effectiveSettings(computeInfo(env).settings?.deployment, await savedDeploymentSettings(env));
}

/** An instance row's provider settings as the provider gets them (instances.provider_settings, 0032). */
export function instanceSettings(env: Pick<Env, 'COMPUTE_PROVIDER'>, raw: string | null | undefined): SettingValues {
  return effectiveSettings(computeInfo(env).settings?.instance, storedValues(raw, env.COMPUTE_PROVIDER));
}

function edgeFor(env: Env, fetchImpl: typeof fetch): EdgeProvider {
  if (env.EDGE_PROVIDER === 'fake') return createFakeEdge(env);
  if (env.EDGE_PROVIDER === 'cloudflare') return createCloudflareEdge(env, bind(fetchImpl));
  throw new Error(`unknown EDGE_PROVIDER: ${env.EDGE_PROVIDER as string}`);
}

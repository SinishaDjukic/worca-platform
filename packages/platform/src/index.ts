// @worca/platform: what a deployment's worca.config.ts and tooling import.
// The Workers come from @worca/platform/control and @worca/platform/gate.
export { definePlatform } from './shared/platform';
export type { GateLogo, PlatformDefinition, PlatformExtensions } from './shared/platform';
export {
  ENVIRONMENTS,
  FEATURE_NAMES,
  NAME_KEYS,
  parsePlatformConfig,
  platformConfigSchema,
  resourceNames,
  wranglerVars,
} from './shared/config';
export type { Environment, EnvironmentConfig, FeatureName, NameKey, PlatformConfig, PlatformConfigInput } from './shared/config';

/** Typed identity for a deployment's worca.config.ts: `export default defineConfig({ … })`. */
export function defineConfig<T extends import('./shared/config').PlatformConfigInput>(config: T): T {
  return config;
}

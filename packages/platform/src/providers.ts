// @worca/platform/providers: the compute and edge provider interfaces and the built-in providers
// (docs/providers.md). A custom provider is registered with createControl(config, { providers }).
export type * from './control/providers/types';
export type { SettingField, SettingKind, SettingValue, SettingValues, SettingsDeclaration } from './control/providers/settings';
export { railwayCompute, createRailwayProvider } from './control/providers/railway';
export { fakeCompute, createFakeCompute, createFakeEdge } from './control/providers/fake';
export { createCloudflareEdge } from './control/providers/cloudflare';
export { STANDARD_SIZES, STANDARD_DEFAULT_SIZE } from './control/providers/standard-sizes';
export { fetchWithRetry, type Fetch, type ProviderOptions } from './control/providers/http';

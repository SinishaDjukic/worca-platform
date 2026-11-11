// definePlatform(): the module-level registry for what a deployment adds in code rather than in
// `vars`: custom compute providers, the gate's logo and, later,
// mail templates. A deployment's entry module calls it once at load, before the Worker handles
// anything; Workflows and RPC classes, which get no request context, read it from here.
import type { ComputeProviderDefinition } from '../control/providers/types';
import { parsePlatformConfig, type PlatformConfig, type PlatformConfigInput } from './config';

/** The gate's logo: the gate has no static files of its own, so its pages inline it (docs/branding.md). */
export interface GateLogo {
  /** An alpha mask (PNG): its bytes, or a data: URI. The page colours it with the text colour. */
  mask: ArrayBuffer | Uint8Array | string;
  /** width/height of the mask, e.g. 205/76 (default). */
  aspect?: `${number}/${number}`;
}

/** Code-level additions: providers registered by name (docs/providers.md), branding bytes. */
export interface PlatformExtensions {
  providers?: {
    /** Compute providers by name; the config's providers.compute picks one. Built-in names can't be replaced. */
    compute?: Record<string, ComputeProviderDefinition>;
  };
  branding?: { gateLogo?: GateLogo };
}

export interface PlatformDefinition {
  config: PlatformConfig;
  providers: { compute: Readonly<Record<string, ComputeProviderDefinition>> };
  /** The gate logo as a data: URI and its aspect ratio, when the deployment brings its own. */
  branding: { gateLogo: { dataUri: string; aspect: string } | null };
}

function toDataUri(mask: GateLogo['mask']): string {
  if (typeof mask === 'string') {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(mask)) throw new Error('definePlatform: branding.gateLogo.mask must be a data:image/png;base64 URI or PNG bytes');
    return mask;
  }
  const bytes = mask instanceof Uint8Array ? mask : new Uint8Array(mask);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

const BUILTIN_COMPUTE_NAMES = ['railway', 'fake'];

let defined: PlatformDefinition | null = null;

/**
 * Validates the config, registers it and the extensions for this isolate, and returns them.
 * Calling it again replaces both (tests).
 */
export function definePlatform(config: PlatformConfigInput, extensions: PlatformExtensions = {}): PlatformDefinition {
  const compute = extensions.providers?.compute ?? {};
  for (const name of Object.keys(compute)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`definePlatform: compute provider name "${name}": lowercase letters, digits and dashes`);
    if (BUILTIN_COMPUTE_NAMES.includes(name)) throw new Error(`definePlatform: "${name}" is a built-in compute provider`);
  }
  const logo = extensions.branding?.gateLogo;
  if (logo?.aspect && !/^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(logo.aspect)) throw new Error('definePlatform: branding.gateLogo.aspect is width/height, e.g. 205/76');
  defined = {
    config: parsePlatformConfig(config),
    providers: { compute: { ...compute } },
    branding: { gateLogo: logo ? { dataUri: toDataUri(logo.mask), aspect: logo.aspect ?? '205/76' } : null },
  };
  return defined;
}

/** What definePlatform registered, or null when the Worker runs without it (today's entry modules). */
export function platform(): PlatformDefinition | null {
  return defined;
}

/** Forgets what definePlatform registered (tests). */
export function resetPlatform(): void {
  defined = null;
}

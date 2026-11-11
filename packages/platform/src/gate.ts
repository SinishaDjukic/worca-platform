// @worca/platform/gate: the gate Worker. A deployment's src/gate.ts:
//
//   import config from '../worca.config';
//   import { createGate } from '@worca/platform/gate';
//   const gate = createGate(config);
//   export default gate.worker;
//   export const { GateObject, GateRpc } = gate;
//
// GateObject is a Durable Object class and GateRpc an RPC entrypoint: Cloudflare binds both by
// class name, so the names must stay exactly these (a rename needs a renamed_classes migration).
import worker, { GateObject, GateRpc } from './gate/index';
import { definePlatform, type PlatformExtensions } from './shared/platform';
import type { PlatformConfigInput } from './shared/config';

export interface GateExports {
  worker: typeof worker;
  GateObject: typeof GateObject;
  GateRpc: typeof GateRpc;
}

/** Registers the deployment's config and extensions (definePlatform) and returns the Worker and its classes. */
export function createGate(config: PlatformConfigInput, extensions?: PlatformExtensions): GateExports {
  definePlatform(config, extensions);
  return { worker, GateObject, GateRpc };
}

export type { Env as GateEnv } from './gate/env';

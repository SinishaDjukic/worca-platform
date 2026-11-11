// @worca/platform/control: the control plane Worker. A deployment's src/control.ts:
//
//   import config from '../worca.config';
//   import { createControl } from '@worca/platform/control';
//   const control = createControl(config);
//   export default control.worker;
//   export const { ControlRpc, InstanceOpsWorkflow, KeyRotationWorkflow, NewsletterSendWorkflow } = control;
//
// Cloudflare binds the RPC entrypoint and the Workflows by class name, so the deployment's entry
// module must export them under exactly these names.
import worker, { ControlRpc, InstanceOpsWorkflow, KeyRotationWorkflow, NewsletterSendWorkflow } from './control/index';
import { definePlatform, type PlatformExtensions } from './shared/platform';
import type { PlatformConfigInput } from './shared/config';

export interface ControlExports {
  worker: typeof worker;
  ControlRpc: typeof ControlRpc;
  InstanceOpsWorkflow: typeof InstanceOpsWorkflow;
  KeyRotationWorkflow: typeof KeyRotationWorkflow;
  NewsletterSendWorkflow: typeof NewsletterSendWorkflow;
}

/** Registers the deployment's config and extensions (definePlatform) and returns the Worker and its classes. */
export function createControl(config: PlatformConfigInput, extensions?: PlatformExtensions): ControlExports {
  definePlatform(config, extensions);
  return { worker, ControlRpc, InstanceOpsWorkflow, KeyRotationWorkflow, NewsletterSendWorkflow };
}

export type { Env as ControlEnv } from './control/env';

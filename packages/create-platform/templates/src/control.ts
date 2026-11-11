import config from '../worca.config';
import { createControl } from '@worca/platform/control';

const control = createControl(config);
export default control.worker;
// Cloudflare binds these by class name: keep the names.
export const { ControlRpc, InstanceOpsWorkflow, KeyRotationWorkflow, NewsletterSendWorkflow } = control;

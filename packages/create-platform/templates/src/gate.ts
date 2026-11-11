import config from '../worca.config';
import { createGate } from '@worca/platform/gate';

const gate = createGate(config);
export default gate.worker;
// Cloudflare binds these by class name: keep the names.
export const { GateObject, GateRpc } = gate;

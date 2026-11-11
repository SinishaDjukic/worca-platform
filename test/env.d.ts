import type { Env as ControlEnv } from '../packages/platform/src/control/env';
import type { Env as GateEnv } from '../packages/platform/src/gate/env';

// `env` from cloudflare:test carries the bindings of whichever Worker the project tests.
// Fakes in test/fakes add helpers (calls, reset, script); reach them with a cast.
declare global {
  namespace Cloudflare {
    interface Env extends ControlEnv, Omit<GateEnv, keyof ControlEnv> {}
  }
}
export {};

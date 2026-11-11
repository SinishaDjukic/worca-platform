import { handleRequest } from './handler';
import type { Env } from './env';

export { GateObject } from './gate-object';
export { GateRpc } from './rpc';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

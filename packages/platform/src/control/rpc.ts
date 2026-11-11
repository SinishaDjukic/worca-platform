import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CodeExchange, ControlRpcApi, TokenRenewal, WakePhase } from '../shared/contracts';
import type { Env } from './env';
import { exchangeCode, renewToken } from './identity/rpc-handlers';
import { requestSuspend, requestWake } from './instances/rpc-handlers';
import { wakePhase } from './instances/progress';

/** The gate calls these over its service binding (D45). Not reachable from the internet. */
export class ControlRpc extends WorkerEntrypoint<Env> implements ControlRpcApi {
  exchangeCode(code: string, host: string): Promise<CodeExchange | null> {
    return exchangeCode(this.env, code, host);
  }
  renewToken(input: { cpSessionId: string; userId: string; host: string }): Promise<TokenRenewal | null> {
    return renewToken(this.env, input);
  }
  requestSuspend(instanceId: string): Promise<void> {
    return requestSuspend(this.env, this.ctx, instanceId);
  }
  requestWake(instanceId: string, reason: 'visit' | 'schedule'): Promise<void> {
    return requestWake(this.env, this.ctx, instanceId, reason);
  }
  wakePhase(instanceId: string): Promise<WakePhase | null> {
    return wakePhase(this.env, instanceId);
  }
}

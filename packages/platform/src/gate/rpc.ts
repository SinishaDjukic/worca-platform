// GateRpc: what the control plane calls over its service binding (contracts.ts GateRpcApi).
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { GateRpcApi, GateState, HostEntry, InstanceStatus, SessionFilter } from '../shared/contracts';
import { gateStub } from './config';
import type { Env } from './env';

export class GateRpc extends WorkerEntrypoint<Env> implements GateRpcApi {
  async putHost(host: string, entry: HostEntry): Promise<void> {
    await this.env.HOSTS.put(host.toLowerCase(), JSON.stringify(entry));
  }

  async deleteHost(host: string): Promise<void> {
    await this.env.HOSTS.delete(host.toLowerCase());
  }

  async setStatus(instanceId: string, status: InstanceStatus, onlyFrom?: InstanceStatus[]): Promise<void> {
    await gateStub(this.env, instanceId).setStatus(instanceId, status, onlyFrom);
  }

  async dropSessions(instanceId: string, filter: SessionFilter): Promise<number> {
    return gateStub(this.env, instanceId).dropSessions(filter);
  }

  async heartbeat(instanceId: string, beat: { suspendable: boolean; nextScheduledAt: number | null }): Promise<void> {
    await gateStub(this.env, instanceId).heartbeat(instanceId, beat);
  }

  async destroy(instanceId: string): Promise<void> {
    await gateStub(this.env, instanceId).destroy();
  }

  async getState(instanceId: string): Promise<GateState> {
    const state = await gateStub(this.env, instanceId).getState();
    return { ...state, instanceId };
  }
}

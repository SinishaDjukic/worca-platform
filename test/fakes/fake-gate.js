// Stands in for the gate's GateRpc in control-plane unit tests. Records every call;
// tests read them back with `env.GATE.calls()` and clear them with `env.GATE.reset()`.
import { WorkerEntrypoint } from 'cloudflare:workers';

let calls = [];
const hosts = new Map();
const states = new Map();

export class FakeGateRpc extends WorkerEntrypoint {
  async putHost(host, entry) { calls.push(['putHost', host, entry]); hosts.set(host, entry); }
  async deleteHost(host) { calls.push(['deleteHost', host]); hosts.delete(host); }
  async setStatus(instanceId, status, onlyFrom) {
    calls.push(onlyFrom ? ['setStatus', instanceId, status, onlyFrom] : ['setStatus', instanceId, status]);
    const current = states.get(instanceId)?.status ?? 'unknown';
    if (onlyFrom && !onlyFrom.includes(current)) return;
    states.set(instanceId, { ...(states.get(instanceId) ?? {}), status });
  }
  async dropSessions(instanceId, filter) { calls.push(['dropSessions', instanceId, filter]); return 0; }
  async heartbeat(instanceId, beat) { calls.push(['heartbeat', instanceId, beat]); }
  async destroy(instanceId) { calls.push(['destroy', instanceId]); states.delete(instanceId); }
  async getState(instanceId) {
    const s = states.get(instanceId) ?? {};
    // A gate object that can't say (no lastVisit); a thrown error is only logged noise in workerd.
    if (s.unreadable) return { instanceId, status: 'unknown' };
    return { instanceId, status: s.status ?? 'unknown', sessions: 0, lastVisit: s.lastVisit ?? null, suspendable: null, nextScheduledAt: null, waking: false, alarmAt: null };
  }
  /** Tests only: what getState reports (`lastVisit`), or `unreadable: true` for a state without one. */
  async setState(instanceId, patch) { states.set(instanceId, { ...(states.get(instanceId) ?? {}), ...patch }); }
  async calls() { return calls; }
  async hosts() { return Object.fromEntries(hosts); }
  async reset() { calls = []; hosts.clear(); states.clear(); }
}

export default { fetch() { return new Response('fake-gate'); } };

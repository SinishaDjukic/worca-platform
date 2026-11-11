// Stands in for the control plane's ControlRpc in gate unit tests. Behaviour is scripted by
// the test through `env.CONTROL.script({...})`; every call is recorded.
import { WorkerEntrypoint } from 'cloudflare:workers';

let calls = [];
let script = { codes: {}, renew: null };

export class FakeControlRpc extends WorkerEntrypoint {
  // codes: { [code]: CodeExchange & { host } }  renew: TokenRenewal | null
  async script(s) { script = { codes: {}, renew: null, ...s }; calls = []; }
  async exchangeCode(code, host) {
    calls.push(['exchangeCode', code, host]);
    const hit = script.codes[code];
    if (!hit || hit.host !== host) return null;
    delete script.codes[code];
    const { host: _h, ...rest } = hit;
    return rest;
  }
  async renewToken(input) { calls.push(['renewToken', input]); return script.renew; }
  async requestSuspend(instanceId) { calls.push(['requestSuspend', instanceId]); }
  async requestWake(instanceId, reason) { calls.push(['requestWake', instanceId, reason]); }
  // script.wakePhase: 'starting' | 'waiting' | null (G1)
  async wakePhase(instanceId) { calls.push(['wakePhase', instanceId]); return script.wakePhase ?? null; }
  async calls() { return calls; }
}

export default { fetch() { return new Response('fake-control'); } };

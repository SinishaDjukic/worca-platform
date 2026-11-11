// G1: the starting page's sub-state ("starting services", then "waiting for worca").
import { describe, expect, it } from 'vitest';
import { GATE_PATHS } from '../../../packages/platform/src/shared/contracts';
import { WAKE_PHASE_TEXT } from '../../../packages/platform/src/gate/pages';
import { control, gate, mintCookie, newInstance, signIn, stub } from './helpers';

const api = { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
const scriptPhase = (wakePhase: string | null) =>
  (control as unknown as { script(s: Record<string, unknown>): Promise<void> }).script({ wakePhase });

describe('wake phase (G1)', () => {
  it('the status answer carries the phase while suspended, and asks nothing once running', async () => {
    const inst = await newInstance();
    const { sid } = await signIn(inst);
    await stub(inst).setStatus(inst.instanceId, 'suspended');
    const cookie = await mintCookie(inst, sid, { passExp: 0 });

    const page = await gate(new Request(inst.url('/'), { headers: { ...nav, cookie } }));
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain('id="phase"');
    expect(html).toContain(WAKE_PHASE_TEXT.waiting);

    await scriptPhase('starting');
    const status = () => gate(new Request(inst.url(GATE_PATHS.status), { headers: { ...api, cookie } })).then((r) => r.json());
    expect(await status()).toEqual({ status: 'suspended', phase: 'starting' });
    await scriptPhase('waiting');
    expect(await status()).toEqual({ status: 'suspended', phase: 'waiting' });
    expect((await control.calls()).filter((c) => c[0] === 'wakePhase')).toEqual([['wakePhase', inst.instanceId]]);

    await stub(inst).setStatus(inst.instanceId, 'running');
    await scriptPhase('waiting');
    expect(await status()).toEqual({ status: 'running' });
    expect((await control.calls()).filter((c) => c[0] === 'wakePhase')).toHaveLength(0);
  });
});

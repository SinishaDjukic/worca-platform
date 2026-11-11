// KeyRotationWorkflow: drives an org's re-encryption job (keys-jobs.ts) one bounded step at a
// time. Step results are counts only, never key material or plaintext. A run that uses up its
// step budget hands over to a fresh instance, so any amount of data fits the Workflow limits.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { runOrgJobStep, workflowId, type StepResult } from './keys-jobs';

export interface KeyRotationParams {
  orgId: string;
  version: number;
  hop?: number;
}

const STEP_CONFIG = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

/** Steps per instance, well under the Workflows per-instance step limit. */
const MAX_STEPS = 400;

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export class KeyRotationWorkflow extends WorkflowEntrypoint<Env, KeyRotationParams> {
  async run(event: WorkflowEvent<KeyRotationParams>, step: WorkflowStep): Promise<StepResult | { state: 'continued'; hop: number }> {
    const { orgId, version } = event.payload;
    const doStep = ((name: string, fn: () => Promise<unknown>) =>
      (step.do as unknown as (n: string, c: unknown, f: () => Promise<unknown>) => Promise<unknown>)(name, STEP_CONFIG, fn)) as Step;
    // After sleeping out the verification grace, the step may treat it as over (its deadline).
    let notBefore = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
      const r = await doStep(`step ${i}`, () => runOrgJobStep(this.env, orgId, version, { now: Math.max(Date.now(), notBefore) }));
      if (r.state === 'wait') {
        await step.sleep(`grace ${i}`, Math.max(r.waitMs, 1000));
        notBefore = r.readyAt;
        continue;
      }
      if (r.state !== 'progress') {
        console.log(JSON.stringify({ at: 'keys.workflow', orgId, version, state: r.state }));
        return r;
      }
    }
    const hop = (event.payload.hop ?? 0) + 1;
    await doStep('continue', async () => {
      await this.env.KEY_ROTATION?.create({ id: workflowId(orgId, version, hop), params: { orgId, version, hop } });
      return hop;
    });
    return { state: 'continued', hop };
  }
}

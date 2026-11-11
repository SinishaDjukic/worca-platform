// InstanceOpsWorkflow: a thin durable wrapper around ops.ts. Every step is retried with backoff
// and its result is persisted, so a restarted run resumes after the last finished step.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { providersFor } from '../providers';
import type { OpParams } from './api';
import { runOp, type OpResult, type StepRunner } from './ops';
import { opIdForWorkflow } from './progress';

const STEP_CONFIG = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export function workflowSteps(step: WorkflowStep): StepRunner {
  return {
    do<T>(name: string, fn: () => Promise<T>, opts?: { sensitive?: boolean }): Promise<T> {
      const config = opts?.sensitive ? { ...STEP_CONFIG, sensitive: 'output' as const } : STEP_CONFIG;
      // Step outputs are plain JSON here; the Serializable constraint can't see through T.
      return (step.do as unknown as (n: string, c: unknown, f: () => Promise<T>) => Promise<T>)(name, config, fn);
    },
    sleep: (name, ms) => step.sleep(name, ms),
  };
}

export class InstanceOpsWorkflow extends WorkflowEntrypoint<Env, OpParams> {
  async run(event: WorkflowEvent<OpParams>, step: WorkflowStep): Promise<OpResult> {
    // startOp recorded the operation under this Workflow id before creating the run.
    const opId = await opIdForWorkflow(this.env, event.instanceId);
    const result = await runOp({ env: this.env, providers: await providersFor(this.env), steps: workflowSteps(step), opId }, event.payload);
    console.log(JSON.stringify({ at: 'instances.workflow', op: event.payload.op, instanceId: event.payload.instanceId, ...result }));
    return result;
  }
}

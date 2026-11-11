// NewsletterSendWorkflow (D70): sends one issue, one Resend batch per step (sendIssueBatch). When
// today's quota (less the transactional reserve) is used up, it sleeps until the next UTC day and
// carries on. The issue ends 'sent', or 'failed' when a batch keeps failing.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { finishIssue, sendIssueBatch, type BatchResult, type NewsletterSendParams } from './core';

const STEP_CONFIG = {
  retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

/** Batches and sleeps per run, well under the Workflows per-instance step limit. */
export const MAX_STEPS = 400;

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface NewsletterSendResult {
  state: 'sent' | 'failed';
  sent: number;
}

/** The loop, apart from the Workflow runtime so tests can drive it with plain functions. */
export async function runNewsletterSend(
  env: Env,
  params: NewsletterSendParams,
  doStep: Step,
  sleep: (name: string, ms: number) => Promise<void>,
): Promise<NewsletterSendResult> {
  let cursor = '';
  let sent = 0;
  try {
    let finished = false;
    for (let i = 0; i < MAX_STEPS && !finished; i++) {
      const r: BatchResult = await doStep(`batch ${i}`, () => sendIssueBatch(env, params.issueId, cursor, { notes: params.notes ?? null }));
      if (r.state === 'wait') {
        await sleep(`quota ${i}`, r.waitMs);
        continue;
      }
      if (r.state === 'done') {
        finished = true;
        continue;
      }
      cursor = r.cursor;
      sent += r.sent;
      finished = r.last;
    }
    if (!finished) throw new Error('step budget used up');
  } catch (err) {
    console.error(JSON.stringify({ at: 'newsletter.workflow', issueId: params.issueId, message: (err as Error).message }));
    await doStep('failed', () => finishIssue(env, params.issueId, 'failed'));
    return { state: 'failed', sent };
  }
  await doStep('finish', () => finishIssue(env, params.issueId, 'sent'));
  console.log(JSON.stringify({ at: 'newsletter.workflow', issueId: params.issueId, sent }));
  return { state: 'sent', sent };
}

export class NewsletterSendWorkflow extends WorkflowEntrypoint<Env, NewsletterSendParams> {
  async run(event: WorkflowEvent<NewsletterSendParams>, step: WorkflowStep): Promise<NewsletterSendResult> {
    const doStep = ((name: string, fn: () => Promise<unknown>) =>
      (step.do as unknown as (n: string, c: unknown, f: () => Promise<unknown>) => Promise<unknown>)(name, STEP_CONFIG, fn)) as Step;
    return runNewsletterSend(this.env, event.payload, doStep, (name, ms) => step.sleep(name, ms));
  }
}

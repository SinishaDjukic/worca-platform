// Provider failures as tenants see them (D15): a code and a source, never the provider's text.
import { describe, expect, it } from 'vitest';
import { problemCode, problemSource, tenantError, tenantOpView, type OpRow } from '../../../packages/platform/src/control/instances/progress';

const RAILWAY_LIMIT = "railway serviceCreate: You've hit the service creation limit for new accounts (25 services per day). Contact us at station.railway.com to raise this.";

describe('problemCode', () => {
  it('names the kinds of failure the providers report', () => {
    expect(problemCode(RAILWAY_LIMIT)).toBe('provider_limit');
    expect(problemCode('cloudflare tunnel create: HTTP 403 [{"code":10000,"message":"Authentication error"}]')).toBe('provider_auth');
    expect(problemCode('railway projectCreate: HTTP 503')).toBe('provider_unavailable');
    expect(problemCode('railway: fetch failed')).toBe('provider_unavailable');
    expect(problemCode('railway: not stopped yet: worca dep-1 SUCCESS deploymentStopped=false')).toBe('provider_slow');
    expect(problemCode('railway deploy: manifest unknown')).toBe('image_missing');
    expect(problemCode('Too many subrequests by single Worker invocation.')).toBe('platform_error');
    expect(problemCode(null)).toBeNull();
  });

  it('says which provider when the message does', () => {
    expect(problemSource(RAILWAY_LIMIT)).toBe('compute');
    expect(problemSource('cloudflare dns create: HTTP 500')).toBe('network');
    expect(problemSource('Too many subrequests')).toBeNull();
  });
});

describe('tenantError', () => {
  it('keeps known codes and reduces a failed create to a code and reason', () => {
    expect(tenantError('no_heartbeat')).toEqual({ error: 'no_heartbeat', errorReason: null, errorSource: null });
    expect(tenantError(`create_failed: ${RAILWAY_LIMIT}`)).toEqual({ error: 'create_failed', errorReason: 'provider_limit', errorSource: 'compute' });
    expect(tenantError(null)).toEqual({ error: null, errorReason: null, errorSource: null });
  });

  it('never passes provider text through', () => {
    const out = tenantError('railway: something about project proj-123 went wrong');
    expect(JSON.stringify(out)).not.toMatch(/proj-123|railway/);
  });
});

describe('tenantOpView', () => {
  const row = (over: Partial<OpRow>): OpRow => ({
    op_id: 'op', instance_id: 'i', org_id: 'o', kind: 'create', workflow_id: null, phase: 'compute', phase_started_at: 1,
    step: 'create project', step_running: 1, attempts: 3, started_at: 1, updated_at: 2, finished_at: null, status: 'running',
    outcome: null, last_error: RAILWAY_LIMIT, ...over,
  });

  it('shows a retried step\'s problem as a code, without the step or the text', () => {
    const v = tenantOpView(row({}));
    expect(v.problem).toBe('provider_limit');
    expect(v.problemSource).toBe('compute');
    expect(JSON.stringify(v)).not.toMatch(/create project|station\.railway|25 services/);
  });

  it('no problem once the step succeeded, or when the op is over', () => {
    expect(tenantOpView(row({ last_error: null })).problem).toBeNull();
    expect(tenantOpView(row({ status: 'failed' })).problem).toBeNull();
  });
});

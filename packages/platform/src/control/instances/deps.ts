// The other modules instances calls (docs/internal-apis.md), behind one seam so unit tests can
// replace them without a full auth/tenancy/keys setup.
import type { MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../env';
import type { KeyRing } from '../keys-api';
import { requireSession } from '../auth/middleware';
import { noticeEmailHtml, sendEmail } from '../auth/email';
import { pruneGateCodes } from '../identity/codes';
import { getKeyRing } from '../keys';
import { auditOrg, auditPlatform, pruneAudit, type OrgAuditEvent, type PlatformAuditEvent } from '../tenancy/audit';
import { registerConfirmAction, startConfirmation } from '../tenancy/confirmations';
import { requireOrgRole } from '../tenancy/roles';
import { siteOf } from '../../shared/site';

export interface AuditOrgEntry {
  actorId: string | null;
  actorScope: 'platform' | 'tenant' | 'system';
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}
export interface AuditPlatformEntry {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
}
export interface ConfirmContext {
  userId: string;
  orgId: string | null;
  target: string;
  payload: unknown;
}
export type ConfirmHandler = (env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, input: ConfirmContext) => Promise<void>;

export interface InstancesDeps {
  getKeyRing(env: Env): KeyRing;
  auditOrg(env: Env, orgId: string, entry: AuditOrgEntry): Promise<unknown>;
  auditPlatform(env: Env, entry: AuditPlatformEntry): Promise<unknown>;
  pruneAudit(env: Env): Promise<unknown>;
  pruneGateCodes(env: Env): Promise<unknown>;
  sendEmail(env: Env, mail: { to: string; subject: string; text: string; html?: string }): Promise<unknown>;
  registerConfirmAction(action: string, handler: ConfirmHandler, opts?: { label?: string }): void;
  startConfirmation(
    env: Env,
    input: { userId: string; orgId: string; action: string; target: string; payload: unknown; summary: string },
  ): Promise<{ id: string; expiresAt: number }>;
  requireSession: MiddlewareHandler<AppContext>;
  requireOrgRole(role?: 'tenant_admin' | 'tenant_user'): MiddlewareHandler<AppContext>;
  /** D79: checks a GitHub App or token when a tenant admin saves it (git-api.ts checkGithub). */
  githubFetch: typeof fetch;
}

const defaults: InstancesDeps = {
  getKeyRing,
  // Our action names extend tenancy's AuditAction union (instance.*); see the final report.
  auditOrg: (env, orgId, e) => auditOrg(env, orgId, e as OrgAuditEvent),
  auditPlatform: (env, e) => auditPlatform(env, e as PlatformAuditEvent),
  pruneAudit: (env) => pruneAudit(env),
  pruneGateCodes: (env) => pruneGateCodes(env),
  sendEmail: (env, mail) =>
    sendEmail(env, { ...mail, html: mail.html ?? noticeEmailHtml({ subject: mail.subject, text: mail.text, site: siteOf(env) }) }),
  registerConfirmAction: (action, handler, opts) => registerConfirmAction(action, handler, opts),
  startConfirmation: (env, input) => startConfirmation(env, input),
  requireSession,
  requireOrgRole: (role) => requireOrgRole(role ?? 'any'),
  githubFetch: (input, init) => fetch(input, init),
};

let current: InstancesDeps = defaults;

export function deps(): InstancesDeps {
  return current;
}

/** Tests only: replace some dependencies; call with no argument to restore the defaults. */
export function setInstancesDeps(overrides?: Partial<InstancesDeps>): void {
  current = overrides ? { ...defaults, ...overrides } : defaults;
}

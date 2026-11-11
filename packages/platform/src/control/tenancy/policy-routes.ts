// Org login policy and per-instance narrowing (D23). A change that can lock members out is a
// destructive action and goes through the emailed confirmation (D31).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppContext, Env } from '../env';
import { gate } from '../gate-client';
import { auditOrg } from './audit';
import { registerConfirmAction, startConfirmation } from './confirmations';
import { deps } from './deps';
import { type AffectedMember, currentPolicyState, describeAffected, getInstanceRequiredMethods, getOrgPolicy, lockOutReport } from './policy';
import { requireOrgRole } from './roles';
import {
  actor,
  DOMAIN_RE,
  domainIndex,
  fail,
  field,
  LOGIN_METHODS,
  normalizeDomain,
  orgInstanceIds,
  orgName,
  orgOwner,
  parseBody,
  tryDecrypt,
} from './util';

export const policyApp = new Hono<AppContext>();

const methodsSchema = z.array(z.enum(LOGIN_METHODS)).max(LOGIN_METHODS.length).transform((m) => [...new Set(m)]);

const orgPolicySchema = z.object({
  allowedMethods: methodsSchema,
  requiredDomain: z
    .string()
    .transform(normalizeDomain)
    .refine((d) => DOMAIN_RE.test(d), 'invalid domain')
    .nullable(),
  confirmName: z.string().optional(),
});
type OrgPolicyInput = { allowedMethods: string[]; requiredDomain: string | null };

const policyDomainField = (orgId: string) => field('org_login_policies', 'required_domain', orgId, orgOwner(orgId));

async function readOrgPolicy(env: Env, orgId: string): Promise<OrgPolicyInput> {
  const row = await env.DB.prepare('SELECT allowed_methods, required_domain FROM org_login_policies WHERE org_id = ?')
    .bind(orgId)
    .first<{ allowed_methods: string; required_domain: string | null }>();
  const p = await getOrgPolicy(env, orgId);
  return { allowedMethods: p.allowedMethods, requiredDomain: row?.required_domain ? await tryDecrypt(env, policyDomainField(orgId), row.required_domain) : null };
}

async function applyOrgPolicy(env: Env, orgId: string, p: OrgPolicyInput, actorId: string): Promise<void> {
  const domain = p.requiredDomain ? await deps().keyRing(env).encrypt(policyDomainField(orgId), p.requiredDomain) : null;
  const idx = p.requiredDomain ? await domainIndex(env, p.requiredDomain) : null;
  await env.DB.prepare(
    `INSERT INTO org_login_policies (org_id, allowed_methods, required_domain, required_domain_index, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET allowed_methods = excluded.allowed_methods, required_domain = excluded.required_domain,
       required_domain_index = excluded.required_domain_index, updated_at = excluded.updated_at`,
  )
    .bind(orgId, JSON.stringify(p.allowedMethods), domain, idx, Date.now())
    .run();
  // Everyone re-enters through /authorize, which applies the new policy (D45). Control-plane
  // sessions stay: the policy governs instance access, which every renewal re-checks.
  await dropInstanceSessions(env, await orgInstanceIds(env, orgId), 'applyOrgPolicy');
  await auditOrg(env, orgId, { actorId, actorScope: 'tenant', action: 'org.policy_updated', targetType: 'org', targetId: orgId, details: p });
}

async function dropInstanceSessions(env: Env, instanceIds: string[], at: string): Promise<void> {
  for (const id of instanceIds) {
    try {
      await gate(env).dropSessions(id, { all: true });
    } catch (err) {
      console.error(JSON.stringify({ at: `${at}.dropSessions`, instanceId: id, message: (err as Error).message }));
    }
  }
}

registerConfirmAction(
  'org.policy.update',
  (env, _ctx, { userId, target, payload }) => applyOrgPolicy(env, target, payload as OrgPolicyInput, userId),
  { label: 'Change the login policy' },
);

// ---- D31 responses, shared with the SSO routes --------------------------------------------------

/**
 * The refusals in front of a change that locks members out (D30, D31, D24), each naming the
 * affected members so the UI can show them: 409 until a confirmName is sent, 422 when it is
 * wrong, 403 without MFA. null: go ahead and start the emailed confirmation.
 */
export function lockOutRefusal(
  c: Context<AppContext>,
  affected: AffectedMember[],
  confirmName: string | undefined,
  expectedName: string | null,
  extra: Record<string, unknown> = {},
): Response | null {
  const { session } = actor(c);
  if (confirmName === undefined) return c.json({ error: 'lock_out_confirmation_required', affected, ...extra }, 409);
  if (expectedName === null || confirmName !== expectedName) return c.json({ error: 'confirm_name_mismatch', affected, ...extra }, 422);
  if (!session.mfa) return c.json({ error: 'mfa_required', affected, ...extra }, 403);
  return null;
}

export function lockOutConfirmationSent(
  c: Context<AppContext>,
  started: { id: string; expiresAt: number },
  affected: AffectedMember[],
  extra: Record<string, unknown> = {},
) {
  return c.json({ status: 'confirmation_sent', confirmationId: started.id, expiresAt: started.expiresAt, affected, ...extra }, 202);
}

const affectedLine = (affected: AffectedMember[]) =>
  affected.length > 0 ? ` ${affected.length} member(s) would no longer be able to sign in or would be signed out: ${describeAffected(affected)}.` : '';

// ---- org policy -------------------------------------------------------------------------------

/** The org policy, plus the instances that narrow it (D23), so the console can list them. */
policyApp.get('/:orgId/policy', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { instanceRequired } = await currentPolicyState(c.env, orgId);
  const instanceOverrides = [...instanceRequired]
    .filter(([, methods]) => methods.length > 0)
    .map(([instanceId, requiredMethods]) => ({ instanceId, requiredMethods }));
  return c.json({ ...(await readOrgPolicy(c.env, orgId)), instanceOverrides });
});

policyApp.put('/:orgId/policy', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const { user } = actor(c);
  const body = await parseBody(c, orgPolicySchema);
  const next: OrgPolicyInput = { allowedMethods: body.allowedMethods, requiredDomain: body.requiredDomain };
  const current = await currentPolicyState(c.env, orgId);
  const affected = await lockOutReport(c.env, orgId, current, {
    ...current,
    orgAllowed: next.allowedMethods,
    requiredDomainIndex: next.requiredDomain ? await domainIndex(c.env, next.requiredDomain) : null,
  });
  if (affected.length === 0) {
    await applyOrgPolicy(c.env, orgId, next, user.id);
    return c.json({ ok: true });
  }
  const name = await orgName(c.env, orgId);
  const refused = lockOutRefusal(c, affected, body.confirmName, name);
  if (refused) return refused;
  const started = await startConfirmation(c.env, {
    userId: user.id,
    orgId,
    action: 'org.policy.update',
    target: orgId,
    payload: next,
    summary:
      `Change the login policy of "${name}" to: methods ${next.allowedMethods.length ? next.allowedMethods.join(', ') : 'any'}; ` +
      `required domain ${next.requiredDomain ?? 'none'}.${affectedLine(affected)}`,
  });
  return lockOutConfirmationSent(c, started, affected);
});

// ---- instance policy (narrowing only) ---------------------------------------------------------

const instanceNameField = (orgId: string, instanceId: string) => field('instances', 'display_name', instanceId, orgOwner(orgId));

async function requireOrgInstance(env: Env, orgId: string, instanceId: string): Promise<{ displayName: string | null }> {
  const row = await env.DB.prepare("SELECT display_name FROM instances WHERE id = ? AND org_id = ? AND status != 'deleting'")
    .bind(instanceId, orgId)
    .first<{ display_name: string }>();
  if (!row) fail(404, 'not_found');
  return { displayName: await tryDecrypt(env, instanceNameField(orgId, instanceId), row.display_name) };
}

interface InstancePolicyInput {
  instanceId: string;
  requiredMethods: string[];
}

async function applyInstancePolicy(env: Env, orgId: string, p: InstancePolicyInput, actorId: string): Promise<void> {
  const { instanceId, requiredMethods } = p;
  if (requiredMethods.length === 0) {
    await env.DB.prepare('DELETE FROM instance_login_policies WHERE instance_id = ?').bind(instanceId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO instance_login_policies (instance_id, required_methods, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (instance_id) DO UPDATE SET required_methods = excluded.required_methods, updated_at = excluded.updated_at`,
    )
      .bind(instanceId, JSON.stringify(requiredMethods), Date.now())
      .run();
    await dropInstanceSessions(env, [instanceId], 'instancePolicy');
  }
  await auditOrg(env, orgId, { actorId, actorScope: 'tenant', action: 'instance.policy_updated', targetType: 'instance', targetId: instanceId, details: { requiredMethods } });
}

registerConfirmAction(
  'instance.policy.update',
  async (env, _ctx, { userId, orgId, payload }) => {
    const p = payload as InstancePolicyInput;
    if (!orgId) throw new Error('instance.policy.update without an org');
    // The instance may have gone, or the org policy changed, since the request.
    const inst = await env.DB.prepare("SELECT 1 FROM instances WHERE id = ? AND org_id = ? AND status != 'deleting'").bind(p.instanceId, orgId).first();
    if (!inst) return;
    const org = await getOrgPolicy(env, orgId);
    if (org.allowedMethods.length > 0 && p.requiredMethods.some((m) => !org.allowedMethods.includes(m))) return;
    await applyInstancePolicy(env, orgId, p, userId);
  },
  { label: 'Change the login policy of an instance' },
);

policyApp.get('/:orgId/instances/:id/policy', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const instanceId = c.req.param('id');
  await requireOrgInstance(c.env, orgId, instanceId);
  const org = await getOrgPolicy(c.env, orgId);
  return c.json({ requiredMethods: await getInstanceRequiredMethods(c.env, instanceId), orgAllowedMethods: org.allowedMethods });
});

policyApp.put('/:orgId/instances/:id/policy', requireOrgRole('tenant_admin'), async (c) => {
  const orgId = c.req.param('orgId');
  const instanceId = c.req.param('id');
  const { user } = actor(c);
  const { requiredMethods, confirmName } = await parseBody(c, z.object({ requiredMethods: methodsSchema, confirmName: z.string().optional() }));
  const { displayName } = await requireOrgInstance(c.env, orgId, instanceId);
  const current = await currentPolicyState(c.env, orgId);
  if (current.orgAllowed.length > 0 && requiredMethods.some((m) => !current.orgAllowed.includes(m))) fail(400, 'not_narrowing'); // D23
  const nextInstances = new Map(current.instanceRequired);
  nextInstances.set(instanceId, requiredMethods);
  const affected = await lockOutReport(c.env, orgId, current, { ...current, instanceRequired: nextInstances });
  const input: InstancePolicyInput = { instanceId, requiredMethods };
  if (affected.length === 0) {
    await applyInstancePolicy(c.env, orgId, input, user.id);
    return c.json({ ok: true });
  }
  const refused = lockOutRefusal(c, affected, confirmName, displayName);
  if (refused) return refused;
  const started = await startConfirmation(c.env, {
    userId: user.id,
    orgId,
    action: 'instance.policy.update',
    target: instanceId,
    payload: input,
    summary: `Change the login policy of the instance "${displayName}" to require: ${requiredMethods.length ? requiredMethods.join(', ') : "the organization's methods"}.${affectedLine(affected)}`,
  });
  return lockOutConfirmationSent(c, started, affected);
});

// Who may use an instance (D19, D23): instance → org membership → teams → login policy.
// Called by identity on /authorize and on every token renewal (D45).
import type { Env } from '../env';
import { deps } from './deps';
import { emailDomain, field, type LoginMethod, normalizeDomain, parseJsonArray, tryDecrypt, userOwner } from './util';

export type AccessDenial = 'not_found' | 'not_member' | 'no_team' | 'policy_method' | 'policy_domain' | 'disabled';

export type AccessResult =
  | { ok: true; orgId: string; teamIds: string[] }
  | { ok: false; reason: AccessDenial; requiredMethods?: string[] };

export interface OrgLoginPolicy {
  allowedMethods: string[]; // empty: every method
  requiredDomainIndex: string | null;
}

export async function getOrgPolicy(env: Env, orgId: string): Promise<OrgLoginPolicy> {
  const row = await env.DB.prepare('SELECT allowed_methods, required_domain_index FROM org_login_policies WHERE org_id = ?')
    .bind(orgId)
    .first<{ allowed_methods: string; required_domain_index: string | null }>();
  return { allowedMethods: parseJsonArray(row?.allowed_methods), requiredDomainIndex: row?.required_domain_index ?? null };
}

export async function getInstanceRequiredMethods(env: Env, instanceId: string): Promise<string[]> {
  const row = await env.DB.prepare('SELECT required_methods FROM instance_login_policies WHERE instance_id = ?')
    .bind(instanceId)
    .first<{ required_methods: string }>();
  return parseJsonArray(row?.required_methods);
}

/**
 * The methods an instance accepts: the org's, narrowed by the instance's (D23). null: any method.
 * An empty array (no overlap left after an org change) admits nobody rather than everybody.
 */
export function effectiveMethods(orgAllowed: string[], instanceRequired: string[]): string[] | null {
  if (instanceRequired.length === 0) return orgAllowed.length > 0 ? orgAllowed : null;
  if (orgAllowed.length === 0) return instanceRequired;
  return instanceRequired.filter((m) => orgAllowed.includes(m));
}

/** Whether a user's email passes an org's required-domain rule. */
export async function emailMatchesDomainIndex(env: Env, email: string | null, requiredIndex: string | null): Promise<boolean> {
  if (!requiredIndex) return true;
  if (!email) return false;
  const idx = await deps().keyRing(env).blindIndex(`domain:${normalizeDomain(emailDomain(email))}`);
  return idx === requiredIndex;
}

export async function checkInstanceAccess(
  env: Env,
  input: { userId: string; sessionMethod: LoginMethod | string; instanceId: string; ssoOrgId?: string | null },
): Promise<AccessResult> {
  const inst = await env.DB.prepare('SELECT id, org_id, status FROM instances WHERE id = ?')
    .bind(input.instanceId)
    .first<{ id: string; org_id: string; status: string }>();
  if (!inst || inst.status === 'deleting') return { ok: false, reason: 'not_found' };

  const user = await env.DB.prepare('SELECT id, email, status FROM user WHERE id = ?')
    .bind(input.userId)
    .first<{ id: string; email: string; status: string | null }>();
  if (!user) return { ok: false, reason: 'not_found' };
  if ((user.status ?? 'active') !== 'active') return { ok: false, reason: 'disabled' };

  const member = await env.DB.prepare('SELECT role FROM member WHERE organizationId = ? AND userId = ?')
    .bind(inst.org_id, input.userId)
    .first();
  if (!member) return { ok: false, reason: 'not_member' };

  // D19: only teams of the instance's own org that the user is in.
  const teams = await env.DB.prepare(
    `SELECT DISTINCT it.team_id AS teamId FROM instance_teams it
     JOIN team t ON t.id = it.team_id AND t.organizationId = ?
     JOIN teamMember tm ON tm.teamId = it.team_id AND tm.userId = ?
     WHERE it.instance_id = ? ORDER BY it.team_id`,
  )
    .bind(inst.org_id, input.userId, inst.id)
    .all<{ teamId: string }>();
  const teamIds = teams.results.map((r) => r.teamId);
  if (teamIds.length === 0) return { ok: false, reason: 'no_team' };

  const org = await getOrgPolicy(env, inst.org_id);
  const email = await tryDecrypt(env, field('user', 'email', user.id, userOwner(user.id)), user.email);
  if (!(await emailMatchesDomainIndex(env, email, org.requiredDomainIndex))) return { ok: false, reason: 'policy_domain' };

  const methods = effectiveMethods(org.allowedMethods, await getInstanceRequiredMethods(env, inst.id));
  // SSO through another org's (or no org's) provider satisfies no method requirement of this org;
  // a sentinel no policy lists, not a weaker real method a policy might allow.
  const method = input.sessionMethod === 'sso' && input.ssoOrgId !== inst.org_id ? 'sso-foreign' : input.sessionMethod;
  if (methods !== null && !methods.includes(method)) {
    return { ok: false, reason: 'policy_method', requiredMethods: methods };
  }
  return { ok: true, orgId: inst.org_id, teamIds };
}

// ---- lock-out analysis (D31) ------------------------------------------------------------------

/** Org and instance policies as the lock-out analysis compares them. */
export interface PolicyState {
  orgAllowed: string[]; // empty: every method
  requiredDomainIndex: string | null;
  /** instance id -> required methods (missing or empty: the org's). */
  instanceRequired: Map<string, string[]>;
}

export type LockOutReason = 'domain' | 'method' | 'signed_out';

export interface AffectedMember {
  id: string;
  name: string | null;
  email: string | null;
  /** domain: their address fails the required domain; method: no allowed method they can use; signed_out: their live session's method stops counting. */
  reasons: LockOutReason[];
  /** Instances they lose (or are signed out of); empty when only the org-level check fails. */
  instanceIds: string[];
}

interface MemberFacts {
  id: string;
  name: string | null;
  email: string | null;
  domainIdx: string | null; // domainIndex of their email's domain
  ssoIdx: string | null; // ssoDomainIndex of their email's domain
  accountProviders: Set<string>;
  hasPasskey: boolean;
  /** Method of their newest live session, as checkInstanceAccess would see it for this org. */
  lastMethod: string | null;
  instanceIds: string[];
}

interface ActiveSsoProvider {
  id: string;
  providerId: string;
  domainIndex: string | null;
}

function toMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toMs(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export async function currentPolicyState(env: Env, orgId: string): Promise<PolicyState> {
  const org = await getOrgPolicy(env, orgId);
  const rows = await env.DB.prepare(
    `SELECT p.instance_id, p.required_methods FROM instance_login_policies p
     JOIN instances i ON i.id = p.instance_id WHERE i.org_id = ? AND i.status != 'deleting'`,
  )
    .bind(orgId)
    .all<{ instance_id: string; required_methods: string }>();
  return {
    orgAllowed: org.allowedMethods,
    requiredDomainIndex: org.requiredDomainIndex,
    instanceRequired: new Map(rows.results.map((r) => [r.instance_id, parseJsonArray(r.required_methods)])),
  };
}

/** The org's SSO providers that can sign people in (domain-verified). */
export async function activeSsoProviders(env: Env, orgId: string): Promise<ActiveSsoProvider[]> {
  const rows = await env.DB.prepare('SELECT id, providerId, domainIndex FROM ssoProvider WHERE organizationId = ? AND domainVerified = 1')
    .bind(orgId)
    .all<ActiveSsoProvider>();
  return rows.results;
}

async function loadMemberFacts(env: Env, orgId: string, now: number): Promise<MemberFacts[]> {
  const members = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.status FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ?`,
  )
    .bind(orgId)
    .all<{ id: string; email: string; name: string | null; status: string | null }>();
  const passkeys = await env.DB.prepare('SELECT DISTINCT p.userId FROM passkey p JOIN member m ON m.userId = p.userId WHERE m.organizationId = ?')
    .bind(orgId)
    .all<{ userId: string }>();
  const accounts = await env.DB.prepare('SELECT a.userId, a.providerId FROM account a JOIN member m ON m.userId = a.userId WHERE m.organizationId = ?')
    .bind(orgId)
    .all<{ userId: string; providerId: string }>();
  const sessions = await env.DB.prepare(
    'SELECT s.userId, s.method, s.ssoOrgId, s.createdAt, s.expiresAt FROM session s JOIN member m ON m.userId = s.userId WHERE m.organizationId = ?',
  )
    .bind(orgId)
    .all<{ userId: string; method: string | null; ssoOrgId: string | null; createdAt: unknown; expiresAt: unknown }>();
  // D19: only teams of this org, only instances that still exist.
  const grants = await env.DB.prepare(
    `SELECT DISTINCT it.instance_id AS instanceId, tm.userId FROM instance_teams it
     JOIN team t ON t.id = it.team_id AND t.organizationId = ?
     JOIN teamMember tm ON tm.teamId = it.team_id
     JOIN instances i ON i.id = it.instance_id AND i.org_id = ? AND i.status != 'deleting'`,
  )
    .bind(orgId, orgId)
    .all<{ instanceId: string; userId: string }>();

  const withPasskey = new Set(passkeys.results.map((r) => r.userId));
  const latest = new Map<string, { at: number; method: string }>();
  for (const s of sessions.results) {
    if (toMs(s.expiresAt) <= now) continue;
    const at = toMs(s.createdAt);
    const raw = s.method ?? 'email-otp';
    const method = raw === 'sso' && s.ssoOrgId !== orgId ? 'sso-foreign' : raw; // as checkInstanceAccess
    const prev = latest.get(s.userId);
    if (!prev || at > prev.at) latest.set(s.userId, { at, method });
  }

  const out: MemberFacts[] = [];
  for (const m of members.results) {
    if ((m.status ?? 'active') !== 'active') continue; // no access either way
    const email = await tryDecrypt(env, field('user', 'email', m.id, userOwner(m.id)), m.email);
    const name = m.name ? await tryDecrypt(env, field('user', 'name', m.id, userOwner(m.id)), m.name) : null;
    const dom = email ? normalizeDomain(emailDomain(email)) : null;
    out.push({
      id: m.id,
      name,
      email,
      domainIdx: dom ? await deps().keyRing(env).blindIndex(`domain:${dom}`) : null,
      ssoIdx: dom ? await deps().keyRing(env).blindIndex(dom) : null,
      accountProviders: new Set(accounts.results.filter((a) => a.userId === m.id).map((a) => a.providerId)),
      hasPasskey: withPasskey.has(m.id),
      lastMethod: latest.get(m.id)?.method ?? null,
      instanceIds: grants.results.filter((g) => g.userId === m.id).map((g) => g.instanceId),
    });
  }
  return out;
}

/** The methods a member can actually complete, given the org's active SSO providers. */
function usableMethods(m: MemberFacts, providers: ActiveSsoProvider[]): string[] {
  const usable = ['email-otp']; // every member has an address the code can go to
  if (m.hasPasskey) usable.push('passkey');
  for (const p of ['google', 'microsoft']) if (m.accountProviders.has(p)) usable.push(p);
  if (providers.some((p) => (m.ssoIdx !== null && p.domainIndex === m.ssoIdx) || m.accountProviders.has(p.providerId))) usable.push('sso');
  return usable;
}

const admits = (methods: string[] | null, method: string) => methods === null || methods.includes(method);

/**
 * D31: who loses a way in when the policy (or the set of SSO providers) goes from `current` to
 * `next`. A member counts when they had an allowed way into the org (or one of their instances)
 * before and have none after, or when the method of their live session stops counting.
 */
export async function lockOutReport(
  env: Env,
  orgId: string,
  current: PolicyState,
  next: PolicyState,
  opts: { removeSsoProviderId?: string; now?: number } = {},
): Promise<AffectedMember[]> {
  const providersNow = await activeSsoProviders(env, orgId);
  const providersNext = providersNow.filter((p) => p.id !== opts.removeSsoProviderId);
  const members = await loadMemberFacts(env, orgId, opts.now ?? Date.now());
  const affected: AffectedMember[] = [];
  for (const m of members) {
    const usableNow = usableMethods(m, providersNow);
    const usableNext = usableMethods(m, providersNext);
    const domainNow = !current.requiredDomainIndex || m.domainIdx === current.requiredDomainIndex;
    const domainNext = !next.requiredDomainIndex || m.domainIdx === next.requiredDomainIndex;
    const reasons = new Set<LockOutReason>();
    const instanceIds: string[] = [];
    const scopes: (string | null)[] = [null, ...m.instanceIds];
    for (const inst of scopes) {
      const now = effectiveMethods(current.orgAllowed, inst ? (current.instanceRequired.get(inst) ?? []) : []);
      const nxt = effectiveMethods(next.orgAllowed, inst ? (next.instanceRequired.get(inst) ?? []) : []);
      const before = domainNow && usableNow.some((u) => admits(now, u));
      const after = domainNext && usableNext.some((u) => admits(nxt, u));
      let hit = false;
      if (before && !after) {
        reasons.add(domainNext ? 'method' : 'domain');
        hit = true;
      }
      if (m.lastMethod && domainNow && admits(now, m.lastMethod) && !admits(nxt, m.lastMethod)) {
        reasons.add('signed_out');
        hit = true;
      }
      if (hit && inst) instanceIds.push(inst);
    }
    if (reasons.size > 0) affected.push({ id: m.id, name: m.name, email: m.email, reasons: [...reasons], instanceIds });
  }
  return affected.sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''));
}

/** One line for confirmation emails: "Ann <ann@x.com>, Bob <bob@y.com> and 3 more". */
export function describeAffected(affected: AffectedMember[], max = 10): string {
  const names = affected.slice(0, max).map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : (a.email ?? a.name ?? a.id)));
  const rest = affected.length - names.length;
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

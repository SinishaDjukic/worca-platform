// Outbound network policy (D73, reworks D34): what Worca's agents may reach on the internet.
// Pure parts here (validation, the effective policy, what counts as loosening, the variables sent to
// worca, the platform's own hosts); storage and the routes are in egress-api.ts / egress-routes.ts.
// docs/security.md "Outbound network", docs/instance-lifecycle.md "Outbound network policy".
import type { Env } from '../env';
import { serviceHost } from '../providers';
import type { EgressVariables } from '../providers/types';
import { heartbeatUrl } from './api';

export const EGRESS_MODES = ['open', 'block', 'allow'] as const;
export type EgressMode = (typeof EGRESS_MODES)[number];

/**
 * A policy. `open`: nothing restricted. `block`: everything except `deny`. `allow`: only `allow`
 * (and the platform's own hosts), minus `deny`: block always wins. Entries are hostnames:
 * `example.com` is exactly that host, `*.example.com` any subdomain of it (not example.com itself).
 * Lists a mode doesn't use are kept empty (normalizePolicy).
 */
export interface EgressPolicy {
  mode: EgressMode;
  allow: string[];
  deny: string[];
}

export const OPEN_POLICY: EgressPolicy = Object.freeze({ mode: 'open', allow: [], deny: [] }) as EgressPolicy;
export const MAX_EGRESS_ENTRIES = 200;

// ---- the platform's own hosts --------------------------------------------------------------------

export interface PlatformHost {
  host: string;
  why: string;
}

/**
 * Hosts the worca service needs to work, always allowed, never blockable, shown read-only. The one
 * place they are listed. The policy only goes to the worca service, so only worca's own calls
 * count: the control plane (heartbeats, and the identity keys it checks sign-ins with) and the
 * instance's credential broker on the instance's private network (agents reach model providers through
 * it, D68). The broker and cloudflared run as their own services and never get the policy, so
 * neither the providers' APIs the broker calls nor Cloudflare's tunnel endpoints (cloudflared's
 * region*.v2.argotunnel.com, api.cloudflare.com) need to be listed here.
 */
export function platformEgressHosts(env: Env): PlatformHost[] {
  const hosts: PlatformHost[] = [{ host: new URL(env.APP_ORIGIN).hostname.toLowerCase(), why: 'Worca platform: heartbeats and sign-in keys' }];
  const beat = new URL(heartbeatUrl(env)).hostname.toLowerCase();
  if (beat !== hosts[0]!.host) hosts.push({ host: beat, why: 'Worca platform: heartbeats' }); // local development only
  hosts.push({ host: serviceHost(env, 'broker'), why: "The instance's credential broker (private network)" });
  return hosts;
}

// ---- entries -------------------------------------------------------------------------------------

/** Why an entry was refused; the console words each one under the field. */
export type EntryProblem = 'scheme' | 'path' | 'port' | 'ip' | 'wildcard' | 'no_dot' | 'label' | 'length' | 'chars' | 'empty';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * One entry, normalized (trimmed, lowercased, a trailing dot dropped, an internationalized name in
 * its punycode form) or the reason it was refused. Hostnames only: no scheme, port, path, IP
 * address, and `*` only as a whole first label (`*.example.com`). Labels 1–63 characters of a–z,
 * 0–9 and inner hyphens; at most 253 characters; at least one dot (so `*.com` is refused).
 */
export function normalizeEntry(raw: string): { entry: string } | { problem: EntryProblem } {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { problem: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) return { problem: 'scheme' };
  if (s.includes('/')) return { problem: 'path' };
  if (s.startsWith('[') || (s.match(/:/g)?.length ?? 0) > 1) return { problem: 'ip' }; // IPv6
  if (s.includes(':')) return { problem: 'port' };
  if (s.endsWith('.')) s = s.slice(0, -1);
  let wildcard = false;
  if (s.startsWith('*.')) {
    wildcard = true;
    s = s.slice(2);
  }
  if (s.includes('*')) return { problem: 'wildcard' };
  if (!s) return { problem: wildcard ? 'no_dot' : 'empty' };
  if (/[^\x00-\x7f]/.test(s)) {
    // Internationalized names in their punycode form, as DNS and proxies see them.
    if (/[\s@?#\\%]/.test(s)) return { problem: 'chars' };
    try {
      s = new URL(`http://${s}`).hostname;
    } catch {
      return { problem: 'chars' };
    }
    if (/[^\x00-\x7f]/.test(s)) return { problem: 'chars' };
  }
  if (IPV4_RE.test(s)) return { problem: 'ip' };
  if (s.length > 253) return { problem: 'length' };
  const labels = s.split('.');
  if (labels.length < 2) return { problem: 'no_dot' };
  for (const l of labels) {
    if (!l || l.length > 63) return { problem: l ? 'length' : 'label' };
    if (!LABEL_RE.test(l)) return { problem: /^[a-z0-9-]+$/.test(l) ? 'label' : 'chars' };
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) return { problem: 'ip' }; // all-numeric TLD: an address, not a name
  return { entry: wildcard ? `*.${s}` : s };
}

/** A refusal of a policy, mapped to a field in the console. */
export interface PolicyProblem {
  code: 'egress_host_invalid' | 'egress_too_many' | 'egress_blocks_platform_host';
  field: 'allow' | 'deny';
  entry?: string;
  reason?: EntryProblem;
}

/** Each entry normalized, blanks skipped, duplicates dropped (first kept); at most 200. */
export function normalizeList(raw: readonly string[], field: 'allow' | 'deny'): { list: string[] } | { problem: PolicyProblem } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!String(r ?? '').trim()) continue;
    const n = normalizeEntry(r);
    if ('problem' in n) return { problem: { code: 'egress_host_invalid', field, entry: String(r).trim().slice(0, 300), reason: n.problem } };
    if (seen.has(n.entry)) continue;
    seen.add(n.entry);
    out.push(n.entry);
  }
  if (out.length > MAX_EGRESS_ENTRIES) return { problem: { code: 'egress_too_many', field } };
  return { list: out };
}

/**
 * The policy as stored: lists the mode doesn't use emptied, every entry normalized, and no block
 * entry that would block one of the platform's own hosts (refused, not dropped).
 */
export function normalizePolicy(
  input: { mode: EgressMode; allow?: readonly string[]; deny?: readonly string[] },
  platform: readonly PlatformHost[],
): { policy: EgressPolicy } | { problem: PolicyProblem } {
  const mode = input.mode;
  let allow: string[] = [];
  let deny: string[] = [];
  if (mode === 'allow') {
    const a = normalizeList(input.allow ?? [], 'allow');
    if ('problem' in a) return a;
    allow = a.list;
  }
  if (mode !== 'open') {
    const d = normalizeList(input.deny ?? [], 'deny');
    if ('problem' in d) return d;
    deny = d.list;
    const hit = deny.find((e) => platform.some((p) => entryMatches(e, p.host)));
    if (hit) return { problem: { code: 'egress_blocks_platform_host', field: 'deny', entry: hit } };
  }
  return { policy: { mode, allow, deny } };
}

// ---- matching -----------------------------------------------------------------------------------

/** Whether an entry matches a host: exactly, or for `*.d` any host ending in `.d`. */
export function entryMatches(entry: string, host: string): boolean {
  const h = host.toLowerCase();
  return entry.startsWith('*.') ? h.endsWith(entry.slice(1)) : h === entry;
}

/** Every host `inner` matches is matched by `outer` (entries as sets of hosts). */
function covers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (!outer.startsWith('*.')) return false; // an exact host covers only itself
  const suffix = outer.slice(1); // ".d"
  return inner.startsWith('*.') ? inner.slice(1).endsWith(suffix) : inner.endsWith(suffix);
}

/** The hosts both entries match, as an entry (always the narrower one), or null when none. */
function intersection(a: string, b: string): string | null {
  if (covers(a, b)) return b;
  if (covers(b, a)) return a;
  return null;
}

const coveredBy = (entry: string, list: readonly string[]) => list.some((o) => covers(o, entry));

/** Whether the policy lets `host` through. The platform's own hosts always go through. */
export function isHostAllowed(policy: EgressPolicy, host: string, platform: readonly PlatformHost[] = []): boolean {
  if (platform.some((p) => p.host === host.toLowerCase())) return true;
  if (policy.deny.some((e) => entryMatches(e, host))) return false;
  return policy.mode !== 'allow' || policy.allow.some((e) => entryMatches(e, host));
}

// ---- levels and loosening -----------------------------------------------------------------------

/** The instance's override if it has one, else the org's policy. */
export function effectivePolicy(org: EgressPolicy, override: EgressPolicy | null): EgressPolicy {
  return override ?? org;
}

export function samePolicy(a: EgressPolicy | null, b: EgressPolicy | null): boolean {
  if (!a || !b) return a === b;
  const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join(',') === [...y].sort().join(',');
  return a.mode === b.mode && same(a.allow, b.allow) && same(a.deny, b.deny);
}

/**
 * Whether going from `from` to `to` could let through a host `from` did not: then the change needs
 * a passkey (MFA) session; tightening and no-op changes don't. Exact over the entry forms we allow
 * (an exact host, or all subdomains of a name), so it never misses one:
 * - to `open`: loosening unless nothing was blocked before (open, or block with an empty list).
 * - from `allow` to `block` or `open`: always (`allow` lets through finitely many names; `block` lets
 *   through all but finitely many).
 * - `block` to `block`: some old block entry is no longer covered by the new blocklist.
 * - `block` to `allow`: some new allow entry reaches a host the old blocklist blocked, and the new
 *   blocklist doesn't block that part again.
 * - `allow` to `allow`: some new allow entry reaches beyond the old allowlist (minus what the new
 *   blocklist blocks), or reaches a host the old blocklist blocked that the new one doesn't (an
 *   allow entry added, a block entry removed or narrowed).
 * - from `open`: never.
 * The platform's own hosts are always let through in every mode, so allowing one is no loosening.
 */
export function isLoosening(from: EgressPolicy, to: EgressPolicy, platform: readonly PlatformHost[] = []): boolean {
  if (from.mode === 'open') return false;
  const blocksNothing = from.mode === 'block' && from.deny.length === 0;
  if (to.mode === 'open') return !blocksNothing;
  if (to.mode === 'block') {
    if (from.mode === 'allow') return true;
    return from.deny.some((d) => !coveredBy(d, to.deny));
  }
  // to.mode === 'allow': each new allow entry, apart from what the new blocklist blocks again, must
  // stay within what `from` let through.
  for (const a of to.allow) {
    if (coveredBy(a, to.deny)) continue;
    if (!a.startsWith('*.') && platform.some((p) => p.host === a)) continue;
    if (from.mode === 'allow' && !coveredBy(a, from.allow)) return true;
    for (const d of from.deny) {
      const both = intersection(a, d);
      if (both && !coveredBy(both, to.deny)) return true;
    }
  }
  return false;
}

// ---- what worca gets ----------------------------------------------------------------------------

/** `*.example.com` in worca's form, `.example.com` (worca-cc docker/egress-proxy.mjs). */
export const worcaEntry = (entry: string) => (entry.startsWith('*.') ? entry.slice(1) : entry);

/**
 * Stands in for an empty blocklist: `.invalid` is reserved and never resolves (RFC 6761), so
 * blocking it blocks nothing. The three variables are always present and never empty, so they are
 * written together in one upsert and no list ever has to be deleted (whether Railway takes '' is
 * unverified); a half-written or missing list can't leave worca looser than the policy.
 */
export const EMPTY_DENY = '.invalid';

/**
 * WORCA_EGRESS_MODE / _ALLOW / _DENY for the worca service (comma-separated, worca's entry form),
 * always all three, never empty. ALLOW starts with the platform's own hosts in every mode (always
 * allowed; worca reads ALLOW only in `allow` mode, and a worca that misread it elsewhere would only
 * be stricter); `allow` mode adds the allowlist. DENY is the blocklist (not in `open` mode), or
 * EMPTY_DENY.
 */
export function egressVariables(policy: EgressPolicy, platform: readonly PlatformHost[]): EgressVariables {
  const allow = [...new Set([...platform.map((p) => p.host), ...(policy.mode === 'allow' ? policy.allow : [])])];
  const deny = policy.mode === 'open' ? [] : policy.deny;
  return { mode: policy.mode, allow: allow.map(worcaEntry).join(','), deny: deny.length ? deny.map(worcaEntry).join(',') : EMPTY_DENY };
}

// Git credentials per instance (D79): storage, the check against GitHub, the change, and what the
// operations write to the services. Pure rules in git.ts. docs/instance-lifecycle.md "Git credentials",
// docs/internal-apis.md "Git credentials".
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../env';
import { sha256Hex, type FieldContext } from '../keys-api';
import type { GitVariables } from '../providers/types';
import { auditOrgSafe, startOp, type InstanceRow } from './api';
import { deps } from './deps';
import { EMPTY_GIT, gitChanges, gitVariables, sameGit, type GithubApp, type GitSettings } from './git';

// ---- storage ------------------------------------------------------------------------------------

const gitField = (orgId: string, instanceId: string): FieldContext => ({
  table: 'instances', column: 'git_settings', rowId: instanceId, owner: { type: 'org', id: orgId },
});

type GitCols = Pick<InstanceRow, 'id' | 'org_id' | 'git_settings'>;

/** The instance's configuration (secrets included); the empty one when nothing is set. */
export async function readGit(env: Env, row: GitCols): Promise<GitSettings> {
  if (!row.git_settings) return { ...EMPTY_GIT, cloneAllow: [] };
  const s = JSON.parse(await deps().getKeyRing(env).decrypt(gitField(row.org_id, row.id), row.git_settings)) as Partial<GitSettings>;
  return {
    github: s.github ?? null,
    azure: s.azure ?? null,
    bitbucket: s.bitbucket ?? null,
    identity: s.identity ?? null,
    cloneAllow: Array.isArray(s.cloneAllow) ? s.cloneAllow : [],
    pushAs: s.pushAs ?? EMPTY_GIT.pushAs,
  };
}

/** Nothing configured at all: stored as NULL (the instance's managed git variables are all removed). */
const isEmpty = (s: GitSettings) => sameGit(s, EMPTY_GIT);

async function sealGit(env: Env, row: Pick<InstanceRow, 'id' | 'org_id'>, s: GitSettings): Promise<string | null> {
  if (isEmpty(s)) return null;
  return deps().getKeyRing(env).encrypt(gitField(row.org_id, row.id), JSON.stringify(s));
}

// ---- what the operations write ------------------------------------------------------------------

/**
 * A stand-in for the broker's git variables, to tell whether the running broker has them (the
 * operations restart it when not). NULL for none; else a SHA-256 over the names and values, so a
 * changed client secret counts. Only ever compared.
 */
export async function brokerGitHash(broker: Record<string, string>): Promise<string | null> {
  const names = Object.keys(broker).sort();
  if (!names.length) return null;
  return sha256Hex(JSON.stringify(names.map((n) => [n, broker[n]])));
}

/**
 * What applying the instance's git configuration means now, or null when the platform never
 * managed it (git_version 0: variables someone set by hand are left alone). `vars` hold secrets:
 * used inside one step, never returned from it.
 */
export async function gitApplyFor(env: Env, row: InstanceRow): Promise<{ vars: GitVariables; version: number; brokerHash: string | null } | null> {
  const version = row.git_version ?? 0;
  if (!version) return null;
  const vars = gitVariables(await readGit(env, row));
  return { vars, version, brokerHash: await brokerGitHash(vars.broker) };
}

/** Whether the running broker lacks what `brokerHash` stands for. */
export const brokerNeedsRestart = (row: Pick<InstanceRow, 'git_broker_applied'>, brokerHash: string | null) => (row.git_broker_applied ?? null) !== brokerHash;

/** The broker now runs with the git variables `brokerHash` stands for. */
export async function markBrokerApplied(env: Env, id: string, brokerHash: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE instances SET git_broker_applied = ? WHERE id = ?`).bind(brokerHash, id).run();
}

// ---- the check against GitHub -------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';

/** A refusal from the GitHub check, mapped to a field in the console (422), or GitHub not answering (502). */
export class GithubCheckError extends Error {
  constructor(
    readonly code: 'git_app_rejected' | 'git_installation_not_found' | 'git_app_not_installed' | 'git_token_rejected' | 'git_private_key_invalid' | 'git_check_failed',
    readonly field: string,
  ) {
    super(code);
  }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** DER length octets. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}
const der = (tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array([tag, ...derLength(body.length), ...body]);

/**
 * The key as PKCS#8 DER, which WebCrypto imports. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`):
 * wrapped as PrivateKeyInfo { version 0, rsaEncryption, the PKCS#1 key }.
 */
export function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return raw;
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlg = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, new Uint8Array([...version, ...rsaAlg, ...der(0x04, raw)]));
}

/** The App's JWT (RS256, ten minutes at most, iat a minute back for clock drift), as GitHub asks. */
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', pkcs8Der(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new GithubCheckError('git_private_key_invalid', 'github.privateKey');
  }
  const t = Math.floor(now / 1000);
  const head = b64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(utf8(JSON.stringify({ iat: t - 60, exp: t + 540, iss: appId })));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(`${head}.${claims}`)));
  return `${head}.${claims}.${b64url(sig)}`;
}

async function githubGet(path: string, auth: string): Promise<Response> {
  try {
    return await deps().githubFetch(`${GITHUB_API}${path}`, {
      method: 'GET',
      headers: { authorization: auth, accept: 'application/vnd.github+json', 'user-agent': 'worca-run', 'x-github-api-version': '2022-11-28' },
    });
  } catch {
    throw new GithubCheckError('git_check_failed', 'github');
  }
}

/** GitHub didn't decide: down, rate-limited or answering something else. */
const undecided = (res: Response) => res.status >= 500 || res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');

/**
 * Checks the GitHub credential of `next` and fills in what GitHub says about it: for an App its
 * slug, name and client ID (the members' sign-in uses it), after confirming the key belongs to the
 * App and the App is installed (on `installationId` when given); for a token, its account.
 * Throws GithubCheckError.
 */
export async function checkGithub(next: GitSettings): Promise<GitSettings> {
  const g = next.github;
  if (!g) return next;
  if (g.kind === 'token') {
    const res = await githubGet('/user', `Bearer ${g.token}`);
    if (undecided(res)) throw new GithubCheckError('git_check_failed', 'github');
    if (!res.ok) throw new GithubCheckError('git_token_rejected', 'github.token');
    const user = (await res.json().catch(() => null)) as { login?: unknown } | null;
    return { ...next, github: { ...g, login: typeof user?.login === 'string' ? user.login : null } };
  }
  const jwt = `Bearer ${await appJwt(g.appId, g.privateKey)}`;
  const res = await githubGet('/app', jwt);
  if (undecided(res)) throw new GithubCheckError('git_check_failed', 'github');
  if (!res.ok) throw new GithubCheckError('git_app_rejected', 'github.privateKey');
  const app = (await res.json().catch(() => null)) as { id?: unknown; slug?: unknown; name?: unknown; client_id?: unknown } | null;
  if (String(app?.id ?? '') !== g.appId) throw new GithubCheckError('git_app_rejected', 'github.appId');
  if (g.installationId) {
    const inst = await githubGet(`/app/installations/${encodeURIComponent(g.installationId)}`, jwt);
    if (undecided(inst)) throw new GithubCheckError('git_check_failed', 'github');
    if (!inst.ok) throw new GithubCheckError('git_installation_not_found', 'github.installationId');
  } else {
    const list = await githubGet('/app/installations?per_page=1', jwt);
    if (undecided(list)) throw new GithubCheckError('git_check_failed', 'github');
    const items = list.ok ? ((await list.json().catch(() => null)) as unknown[] | null) : null;
    if (!Array.isArray(items) || !items.length) throw new GithubCheckError('git_app_not_installed', 'github.installationId');
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const out: GithubApp = { ...g, appSlug: str(app?.slug), appName: str(app?.name), clientId: str(app?.client_id) };
  return { ...next, github: out };
}

// ---- the change ---------------------------------------------------------------------------------

export type GitResult = 'unchanged' | 'applying' | 'saved';

/**
 * A tenant admin's change of the instance's git configuration, decided (passkey or not, checked
 * against GitHub) on `cur`, read with `row`. Compare-and-set on the git_version read there (409
 * git_changed), as remote access (D72) and the outbound network policy (D73):
 * - the same configuration, applied: 'unchanged'; the same still pending on a running instance:
 *   applied again ('applying'), the retry after a failed reconfigure;
 * - running, nothing under way: stored, pending, `reconfigure` started ('applying');
 * - suspended or stopped, nothing under way: stored, pending; the next wake or lift applies it ('saved');
 * - anything else under way, or creating: 409 instance_busy.
 * Audited as `instance.git_updated` with what changed (kinds and names, never a secret).
 */
export async function changeInstanceGit(env: Env, row: InstanceRow, cur: GitSettings, next: GitSettings, actorId: string): Promise<GitResult> {
  const same = sameGit(cur, next);
  const basedOn = row.git_version ?? 0;
  const changedMeanwhile = async () => {
    const now = await env.DB.prepare(`SELECT git_version AS v FROM instances WHERE id = ?`).bind(row.id).first<{ v: number }>();
    return !now || now.v !== basedOn;
  };
  if (same && !(row.git_pending && row.status === 'running')) {
    if (await changedMeanwhile()) throw new HTTPException(409, { message: 'git_changed' });
    return 'unchanged';
  }
  // A retry stores the same values again; a change seals the new ones (GitHub's facts included).
  const sealed = same ? row.git_settings : await sealGit(env, row, next);
  const set = `git_settings = ?, git_version = ?, git_pending = 1, updated_at = ?`;
  const vals = [sealed, basedOn + 1, Date.now()];
  let result: GitResult;
  const run = await env.DB.prepare(`UPDATE instances SET ${set}, pending_op = 'reconfigure' WHERE id = ? AND git_version = ? AND status = 'running' AND pending_op IS NULL`)
    .bind(...vals, row.id, basedOn)
    .run();
  if (run.meta.changes) {
    try {
      await startOp(env, { op: 'reconfigure', instanceId: row.id, actorId });
    } catch (err) {
      // Not started: release the claim; the configuration stays saved and pending.
      await env.DB.prepare(`UPDATE instances SET pending_op = NULL WHERE id = ? AND pending_op = 'reconfigure'`).bind(row.id).run();
      throw err;
    }
    result = 'applying';
  } else {
    const saved = await env.DB.prepare(`UPDATE instances SET ${set} WHERE id = ? AND git_version = ? AND status IN ('suspended', 'stopped') AND pending_op IS NULL`)
      .bind(...vals, row.id, basedOn)
      .run();
    if (!saved.meta.changes) throw new HTTPException(409, { message: (await changedMeanwhile()) ? 'git_changed' : 'instance_busy' });
    result = 'saved';
  }
  if (!same) {
    await auditOrgSafe(env, row.org_id, {
      actorId, actorScope: 'tenant', action: 'instance.git_updated', targetType: 'instance', targetId: row.id,
      details: { changes: gitChanges(cur, next), ...(result === 'saved' ? { appliesOnStart: true } : {}) },
    });
  }
  return result;
}

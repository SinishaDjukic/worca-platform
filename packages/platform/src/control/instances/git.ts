// Git credentials per instance (D79): what a tenant admin sets, how it is checked, what the console
// sees of it (never a secret) and the variables Worca gets. Pure parts here; storage, the GitHub
// checks and the change are in git-api.ts. docs/instance-lifecycle.md "Git credentials".
import type { GitVariables } from '../providers/types';

/** Who pushes and pull requests go out as (Worca's WORCA_GH_AS_PERSON: unset, prefer, required). */
export const PUSH_AS = ['instance', 'prefer', 'required'] as const;
export type PushAs = (typeof PUSH_AS)[number];
/** What a configuration starts with: the person who acted when they connected GitHub, else the instance's credential. */
export const DEFAULT_PUSH_AS: PushAs = 'prefer';

export interface GithubApp {
  kind: 'app';
  appId: string;
  /** The App's private key, PEM. */
  privateKey: string;
  installationId: string | null;
  /** What GitHub answered for the App when it was checked. */
  appSlug: string | null;
  appName: string | null;
  clientId: string | null;
  /** Members may sign in with GitHub through this App on the key page (needs the client secret). */
  signIn: { clientSecret: string } | null;
  setAt: number;
}
export interface GithubToken {
  kind: 'token';
  token: string;
  /** The account GitHub answered for the token when it was checked. */
  login: string | null;
  setAt: number;
}
export interface AzureToken {
  token: string;
  setAt: number;
}
export interface BitbucketToken {
  token: string;
  /** Set: an Atlassian API token of this account; null: a repository, project or workspace access token. */
  email: string | null;
  setAt: number;
}

/** The stored configuration, secrets included (encrypted with the org key, git-api.ts). */
export interface GitSettings {
  github: GithubApp | GithubToken | null;
  azure: AzureToken | null;
  bitbucket: BitbucketToken | null;
  identity: { name: string; email: string } | null;
  cloneAllow: string[];
  pushAs: PushAs;
}

export const EMPTY_GIT: GitSettings = Object.freeze({ github: null, azure: null, bitbucket: null, identity: null, cloneAllow: [], pushAs: DEFAULT_PUSH_AS }) as GitSettings;

// ---- input ----------------------------------------------------------------------------------------

/**
 * A change as the console sends it: the whole wanted state, where a credential's secret left out
 * means "keep the one stored" (allowed only when one of that kind is stored). A host set to null
 * removes its credential; a field left out keeps what is stored.
 */
export interface GitInput {
  github?: { kind: 'app'; appId: string; privateKey?: string; installationId?: string | null; signIn?: { clientSecret?: string } | null } | { kind: 'token'; token?: string } | null;
  azure?: { token?: string } | null;
  bitbucket?: { token?: string; email?: string | null } | null;
  identity?: { name: string; email: string } | null;
  cloneAllow?: string[];
  pushAs?: PushAs;
}

/** Why a change was refused; the console words each one under its field. */
export interface GitProblem {
  code:
    | 'git_secret_required' // a credential of another kind (or none) is stored, so its secret can't be kept
    | 'git_app_id_invalid'
    | 'git_private_key_invalid'
    | 'git_installation_invalid'
    | 'git_token_invalid' // not a plausible token (whitespace, too short or long)
    | 'git_email_invalid'
    | 'git_identity_invalid'
    | 'git_clone_allow_invalid';
  field: string;
  entry?: string;
}

export const MAX_CLONE_ALLOW = 100;
const PEM_RE = /^-----BEGIN (RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+-----END (RSA )?PRIVATE KEY-----$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A token as people paste it: trimmed, one line, 8–1000 printable characters. */
function cleanToken(raw: string): string | null {
  const t = String(raw ?? '').trim();
  if (t.length < 8 || t.length > 1000 || /[\s\x00-\x1f\x7f]/.test(t)) return null;
  return t;
}

/** A PEM private key with its line breaks normalized, or null. */
export function cleanPrivateKey(raw: string): string | null {
  const k = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (k.length > 10_000 || !PEM_RE.test(k)) return null;
  return `${k}\n`;
}

/**
 * One clone allowlist entry as Worca reads it (worca-cc src/core/clone-project.mjs parseCloneAllow):
 * `host/path` of any depth, optionally ending in `/*`, or `host/*`. Lowercased, no scheme, no
 * credentials, no trailing slash. Returns the entry or null.
 */
export function normalizeCloneEntry(raw: string): string | null {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 300) return null;
  s = s.replace(/^https:\/\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (/[\s,@?#\\:]/.test(s) || s.includes('//')) return null;
  const [host, ...path] = s.split('/');
  if (!host || !path.length) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) return null;
  for (const [i, seg] of path.entries()) {
    if (seg === '*') {
      if (i !== path.length - 1) return null;
      continue;
    }
    if (!seg || seg === '.' || seg === '..' || seg.includes('*')) return null;
  }
  return [host, ...path].join('/');
}

/**
 * The input merged onto what is stored, every value checked and normalized, or the first problem.
 * `now` stamps a credential whose secret is new. GitHub facts (`appSlug`, `login`, …) of a credential
 * that changes are cleared here; git-api.ts fills them from GitHub's answer.
 */
export function mergeGitInput(cur: GitSettings, input: GitInput, now: number): { next: GitSettings } | { problem: GitProblem } {
  const next: GitSettings = { ...cur, cloneAllow: [...cur.cloneAllow] };

  if (input.github !== undefined) {
    const g = input.github;
    if (g === null) next.github = null;
    else if (g.kind === 'app') {
      const appId = String(g.appId ?? '').trim();
      if (!/^\d{1,12}$/.test(appId)) return { problem: { code: 'git_app_id_invalid', field: 'github.appId' } };
      const inst = g.installationId === undefined ? (cur.github?.kind === 'app' ? cur.github.installationId : null) : g.installationId === null ? null : String(g.installationId).trim() || null;
      if (inst !== null && !/^\d{1,15}$/.test(inst)) return { problem: { code: 'git_installation_invalid', field: 'github.installationId' } };
      const prev = cur.github?.kind === 'app' ? cur.github : null;
      let privateKey: string;
      if (g.privateKey !== undefined && String(g.privateKey).trim()) {
        const k = cleanPrivateKey(g.privateKey);
        if (!k) return { problem: { code: 'git_private_key_invalid', field: 'github.privateKey' } };
        privateKey = k;
      } else if (prev && prev.appId === appId) privateKey = prev.privateKey;
      else return { problem: { code: 'git_secret_required', field: 'github.privateKey' } };
      const sameApp = !!prev && prev.appId === appId && prev.privateKey === privateKey && prev.installationId === inst;
      let signIn: GithubApp['signIn'];
      if (g.signIn === undefined) signIn = prev && prev.appId === appId ? prev.signIn : null;
      else if (g.signIn === null) signIn = null;
      else if (g.signIn.clientSecret !== undefined && String(g.signIn.clientSecret).trim()) {
        const s = cleanToken(g.signIn.clientSecret);
        if (!s) return { problem: { code: 'git_token_invalid', field: 'github.clientSecret' } };
        signIn = { clientSecret: s };
      } else if (prev?.signIn && prev.appId === appId) signIn = prev.signIn;
      else return { problem: { code: 'git_secret_required', field: 'github.clientSecret' } };
      const keep = sameApp ? prev : null;
      next.github = {
        kind: 'app', appId, privateKey, installationId: inst,
        appSlug: keep?.appSlug ?? null, appName: keep?.appName ?? null, clientId: keep?.clientId ?? null,
        signIn,
        setAt: keep?.setAt ?? now,
      };
    } else if (g.kind === 'token') {
      const prev = cur.github?.kind === 'token' ? cur.github : null;
      if (g.token !== undefined && String(g.token).trim()) {
        const t = cleanToken(g.token);
        if (!t) return { problem: { code: 'git_token_invalid', field: 'github.token' } };
        next.github = prev && prev.token === t ? prev : { kind: 'token', token: t, login: null, setAt: now };
      } else if (prev) next.github = prev;
      else return { problem: { code: 'git_secret_required', field: 'github.token' } };
    }
  }

  if (input.azure !== undefined) {
    const a = input.azure;
    if (a === null) next.azure = null;
    else if (a.token !== undefined && String(a.token).trim()) {
      const t = cleanToken(a.token);
      if (!t) return { problem: { code: 'git_token_invalid', field: 'azure.token' } };
      next.azure = cur.azure?.token === t ? cur.azure : { token: t, setAt: now };
    } else if (!cur.azure) return { problem: { code: 'git_secret_required', field: 'azure.token' } };
  }

  if (input.bitbucket !== undefined) {
    const b = input.bitbucket;
    if (b === null) next.bitbucket = null;
    else {
      const email = b.email === undefined ? (cur.bitbucket?.email ?? null) : b.email === null ? null : String(b.email).trim().toLowerCase() || null;
      if (email !== null && (email.length > 254 || !EMAIL_RE.test(email))) return { problem: { code: 'git_email_invalid', field: 'bitbucket.email' } };
      let token: string;
      if (b.token !== undefined && String(b.token).trim()) {
        const t = cleanToken(b.token);
        if (!t) return { problem: { code: 'git_token_invalid', field: 'bitbucket.token' } };
        token = t;
      } else if (cur.bitbucket && cur.bitbucket.email === email) token = cur.bitbucket.token;
      // A token of the other kind can't be kept: an access token isn't an API token.
      else return { problem: { code: 'git_secret_required', field: 'bitbucket.token' } };
      next.bitbucket = cur.bitbucket && cur.bitbucket.token === token && cur.bitbucket.email === email ? cur.bitbucket : { token, email, setAt: now };
    }
  }

  if (input.identity !== undefined) {
    if (input.identity === null) next.identity = null;
    else {
      const name = String(input.identity.name ?? '').trim();
      const email = String(input.identity.email ?? '').trim();
      if (!name && !email) next.identity = null;
      else {
        if (!name || name.length > 100 || /[\x00-\x1f<>]/.test(name)) return { problem: { code: 'git_identity_invalid', field: 'identity.name' } };
        if (email.length > 254 || !EMAIL_RE.test(email) || /[<>]/.test(email)) return { problem: { code: 'git_email_invalid', field: 'identity.email' } };
        next.identity = { name, email };
      }
    }
  }

  if (input.cloneAllow !== undefined) {
    const out: string[] = [];
    for (const raw of input.cloneAllow) {
      if (!String(raw ?? '').trim()) continue;
      const e = normalizeCloneEntry(raw);
      if (!e) return { problem: { code: 'git_clone_allow_invalid', field: 'cloneAllow', entry: String(raw).trim().slice(0, 300) } };
      if (!out.includes(e)) out.push(e);
    }
    if (out.length > MAX_CLONE_ALLOW) return { problem: { code: 'git_clone_allow_invalid', field: 'cloneAllow' } };
    next.cloneAllow = out;
  }

  if (input.pushAs !== undefined) next.pushAs = input.pushAs;
  return { next };
}

// ---- what a change is ---------------------------------------------------------------------------

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The same credential (secrets compared too), ignoring what GitHub answered about it. */
function sameGithub(a: GitSettings['github'], b: GitSettings['github']): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'app' && b.kind === 'app') {
    return a.appId === b.appId && a.privateKey === b.privateKey && a.installationId === b.installationId && a.signIn?.clientSecret === b.signIn?.clientSecret;
  }
  if (a.kind === 'token' && b.kind === 'token') return a.token === b.token;
  return false;
}

export function sameGit(a: GitSettings, b: GitSettings): boolean {
  return (
    sameGithub(a.github, b.github) &&
    a.azure?.token === b.azure?.token &&
    a.bitbucket?.token === b.bitbucket?.token && (a.bitbucket?.email ?? null) === (b.bitbucket?.email ?? null) &&
    a.identity?.name === b.identity?.name && a.identity?.email === b.identity?.email &&
    sameList(a.cloneAllow, b.cloneAllow) &&
    a.pushAs === b.pushAs
  );
}

/** The GitHub credential is new or changed, so it is checked against GitHub before it is saved. */
export function githubNeedsCheck(cur: GitSettings, next: GitSettings): boolean {
  if (!next.github) return false;
  const a = cur.github;
  const b = next.github;
  if (!a || a.kind !== b.kind) return true;
  if (a.kind === 'app' && b.kind === 'app') return a.appId !== b.appId || a.privateKey !== b.privateKey || a.installationId !== b.installationId || (!!b.signIn && !b.clientId);
  return (a as GithubToken).token !== (b as GithubToken).token;
}

/**
 * Whether the change needs a passkey session (D79, as D72 and D73): adding or replacing a
 * credential or the client secret (with it, whoever saves it decides what Worca pushes as), or
 * changing the clone allowlist. Removing a credential, the commit identity and who pushes go out
 * as don't.
 */
export function gitNeedsMfa(cur: GitSettings, next: GitSettings): boolean {
  if (next.github && !sameGithub(cur.github, next.github)) {
    // Only sign-in turned off on the same App is a removal.
    const a = cur.github;
    const b = next.github;
    const onlySignInOff = a?.kind === 'app' && b.kind === 'app' && a.appId === b.appId && a.privateKey === b.privateKey && a.installationId === b.installationId && !b.signIn;
    if (!onlySignInOff) return true;
  }
  if (next.azure && next.azure.token !== cur.azure?.token) return true;
  if (next.bitbucket && (next.bitbucket.token !== cur.bitbucket?.token || next.bitbucket.email !== (cur.bitbucket?.email ?? null))) return true;
  return !sameList(cur.cloneAllow, next.cloneAllow);
}

/** What changed, for the audit log: field names and kinds, never a secret. */
export function gitChanges(cur: GitSettings, next: GitSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!sameGithub(cur.github, next.github)) {
    out.github = next.github
      ? next.github.kind === 'app'
        ? { kind: 'app', appId: next.github.appId, installationId: next.github.installationId, signIn: !!next.github.signIn }
        : { kind: 'token', login: next.github.login }
      : null;
  }
  if (cur.azure?.token !== next.azure?.token) out.azure = next.azure ? 'set' : null;
  if (cur.bitbucket?.token !== next.bitbucket?.token || (cur.bitbucket?.email ?? null) !== (next.bitbucket?.email ?? null)) {
    out.bitbucket = next.bitbucket ? (next.bitbucket.email ? 'api-token' : 'access-token') : null;
  }
  if (cur.identity?.name !== next.identity?.name || cur.identity?.email !== next.identity?.email) out.identity = next.identity ? 'set' : null;
  if (!sameList(cur.cloneAllow, next.cloneAllow)) out.cloneAllow = next.cloneAllow;
  if (cur.pushAs !== next.pushAs) out.pushAs = { from: cur.pushAs, to: next.pushAs };
  return out;
}

// ---- what the console sees ----------------------------------------------------------------------

const last4 = (s: string) => s.slice(-4);

/** The configuration without a single secret: what each credential is, and its last four characters. */
export function gitView(s: GitSettings) {
  const g = s.github;
  return {
    github: !g
      ? null
      : g.kind === 'app'
        ? { kind: 'app' as const, appId: g.appId, installationId: g.installationId, appSlug: g.appSlug, appName: g.appName, clientId: g.clientId, signIn: !!g.signIn, setAt: g.setAt }
        : { kind: 'token' as const, login: g.login, last4: last4(g.token), setAt: g.setAt },
    azure: s.azure ? { last4: last4(s.azure.token), setAt: s.azure.setAt } : null,
    bitbucket: s.bitbucket ? { kind: s.bitbucket.email ? ('api-token' as const) : ('access-token' as const), email: s.bitbucket.email, last4: last4(s.bitbucket.token), setAt: s.bitbucket.setAt } : null,
    identity: s.identity,
    cloneAllow: s.cloneAllow,
    pushAs: s.pushAs,
  };
}

// ---- what Worca gets -----------------------------------------------------------------------------

/**
 * Every git variable the platform manages on the worca service. Those a configuration doesn't set
 * are removed, so a credential of another kind (Worca prefers App over token pairs over one token)
 * or one set by hand can never win over the configured one. Names from worca-cc
 * src/core/github-credentials.mjs, azure-credentials.mjs, bitbucket-credentials.mjs and
 * clone-project.mjs.
 */
export const WORCA_GIT_VARIABLES = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'WORCA_GH_READ_TOKEN', 'WORCA_GH_WRITE_TOKEN',
  'WORCA_GH_APP_ID', 'WORCA_GH_APP_KEY_B64', 'WORCA_GH_APP_KEY_FILE', 'WORCA_GH_APP_INSTALLATION_ID',
  'WORCA_ADO_TOKEN', 'WORCA_ADO_READ_TOKEN', 'WORCA_ADO_WRITE_TOKEN', 'AZURE_DEVOPS_EXT_PAT',
  'WORCA_BB_TOKEN', 'WORCA_BB_READ_TOKEN', 'WORCA_BB_WRITE_TOKEN', 'WORCA_BB_EMAIL',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'WORCA_CLONE_ALLOW', 'WORCA_GH_AS_PERSON',
]);
/** And on the broker: the GitHub App's client ID and secret for members' sign-in (worca-cc src/broker/config.mjs). */
export const BROKER_GIT_VARIABLES = Object.freeze(['WORCA_BROKER_GITHUB_CLIENT_ID', 'WORCA_BROKER_GITHUB_CLIENT_SECRET', 'WORCA_BROKER_GITHUB_SCOPES']);

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * The variables for a configuration: what to set on each service (never an empty value: git treats
 * an empty GIT_AUTHOR_NAME as an error) and, implicitly, that every other managed name goes.
 */
export function gitVariables(s: GitSettings): GitVariables {
  const worca: Record<string, string> = {};
  const broker: Record<string, string> = {};
  const g = s.github;
  if (g?.kind === 'app') {
    worca.WORCA_GH_APP_ID = g.appId;
    worca.WORCA_GH_APP_KEY_B64 = b64(g.privateKey);
    if (g.installationId) worca.WORCA_GH_APP_INSTALLATION_ID = g.installationId;
    if (g.signIn && g.clientId) {
      broker.WORCA_BROKER_GITHUB_CLIENT_ID = g.clientId;
      broker.WORCA_BROKER_GITHUB_CLIENT_SECRET = g.signIn.clientSecret;
    }
  } else if (g?.kind === 'token') {
    worca.GH_TOKEN = g.token;
  }
  if (s.azure) worca.WORCA_ADO_TOKEN = s.azure.token;
  if (s.bitbucket) {
    worca.WORCA_BB_TOKEN = s.bitbucket.token;
    if (s.bitbucket.email) worca.WORCA_BB_EMAIL = s.bitbucket.email;
  }
  if (s.identity) {
    worca.GIT_AUTHOR_NAME = worca.GIT_COMMITTER_NAME = s.identity.name;
    worca.GIT_AUTHOR_EMAIL = worca.GIT_COMMITTER_EMAIL = s.identity.email;
  }
  if (s.cloneAllow.length) worca.WORCA_CLONE_ALLOW = s.cloneAllow.join(',');
  if (s.pushAs !== 'instance') worca.WORCA_GH_AS_PERSON = s.pushAs;
  return { worca, broker };
}

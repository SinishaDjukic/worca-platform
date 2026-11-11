// Git credentials per instance (D79): tenant admins set the credential Worca uses for each git host,
// the commit identity, the clone allowlist and who pushes go out as; the reconfigure op writes them to
// the worca service (and the GitHub sign-in to the broker) and restarts what needs it.
import { beforeEach, describe, expect, it } from 'vitest';
import { runOp, type OpsContext } from '../../../packages/platform/src/control/instances/ops';
import {
  BROKER_GIT_VARIABLES,
  EMPTY_GIT,
  gitNeedsMfa,
  gitVariables,
  gitView,
  mergeGitInput,
  normalizeCloneEntry,
  WORCA_GIT_VARIABLES,
  type GitSettings,
} from '../../../packages/platform/src/control/instances/git';
import { appJwt, brokerGitHash, pkcs8Der } from '../../../packages/platform/src/control/instances/git-api';
import { getProviders } from '../../../packages/platform/src/control/providers';
import { createRailwayProvider } from '../../../packages/platform/src/control/providers/railway';
import { gitDiff } from '../../../packages/platform/src/control/providers/instance-env';
import type { Env } from '../../../packages/platform/src/control/env';
import type { ComputeRef } from '../../../packages/platform/src/control/providers/types';
import { beat, E, fakeStubFetch, gateFake, githubFake, immediateSteps, installFakes, instanceRow, recorded, seedInstance, seedOrg, testApp } from './instances-helpers';

const app = testApp();
const putGit = (orgId: string, id: string, user: string, body: unknown, mfa = true) =>
  app.call('PUT', `/api/orgs/${orgId}/instances/${id}/git`, { user, body, headers: mfa ? {} : { 'x-test-mfa': '0' } });
const getGit = (orgId: string, id: string, user: string) => app.call('GET', `/api/orgs/${orgId}/instances/${id}/git`, { user });
const sendBeat = (credential: string, body = beat()) =>
  app.call('POST', '/api/heartbeat', { body, headers: { authorization: `Bearer ${credential}` } });

const TOKEN = 'github_pat_11AAAAAAA0abcdefghijkl_9876';
const githubUser = (login = 'octo') => () => Response.json({ login });

// ---- an RSA key, as GitHub hands it out (PKCS#1) and as PKCS#8 ----
const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
async function rsaKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  // PrivateKeyInfo = 30 82 LL LL | 02 01 00 | 30 0d (rsaEncryption, NULL) | 04 82 LL LL <PKCS#1>
  const pkcs1 = pkcs8.slice(4 + 3 + 15 + 4);
  return { publicKey: pair.publicKey, pkcs8Pem: pem('PRIVATE KEY', pkcs8), pkcs1Pem: pem('RSA PRIVATE KEY', pkcs1) };
}
const keys = rsaKey();

/** Verifies the App JWT GitHub would get, then answers as GitHub for App 12345. */
async function githubApp(path: string, auth: string, o: { id?: number; installations?: unknown[]; installation?: boolean } = {}): Promise<Response> {
  const { publicKey } = await keys;
  const [h, c, sig] = auth.replace(/^Bearer /, '').split('.');
  const bin = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (x) => x.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, bin(sig!), new TextEncoder().encode(`${h}.${c}`));
  if (!ok) return new Response('bad jwt', { status: 401 });
  if (path === '/app') return Response.json({ id: o.id ?? 12345, slug: 'acme-worca', name: 'Acme Worca', client_id: 'Iv23liAcme0001' });
  if (path === '/app/installations?per_page=1') return Response.json(o.installations ?? [{ id: 77 }]);
  if (path.startsWith('/app/installations/')) return o.installation === false ? new Response('nope', { status: 404 }) : Response.json({ id: 77 });
  return new Response('?', { status: 404 });
}

async function grant(instanceId: string, teamId: string) {
  await E.DB.prepare(`INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)`).bind(instanceId, teamId).run();
}

function opsCtx(stub: ReturnType<typeof fakeStubFetch>, onSleep?: (name: string) => Promise<void>): OpsContext & { steps: ReturnType<typeof immediateSteps> } {
  return { env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(onSleep), pollMs: 1, maxPolls: 3 };
}

const settings = (patch: Partial<GitSettings> = {}): GitSettings => ({ ...EMPTY_GIT, cloneAllow: [], ...patch });

beforeEach(async () => {
  installFakes();
  await gateFake().reset();
});

describe('git.ts', () => {
  it('a secret left out keeps the stored one only for the same kind', () => {
    const cur = settings({ github: { kind: 'token', token: TOKEN, login: 'octo', setAt: 1 } });
    expect(mergeGitInput(cur, { github: { kind: 'token' } }, 5)).toEqual({ next: cur });
    expect(mergeGitInput(cur, { github: { kind: 'app', appId: '12345' } }, 5)).toEqual({ problem: { code: 'git_secret_required', field: 'github.privateKey' } });
    expect(mergeGitInput(settings(), { azure: {} }, 5)).toEqual({ problem: { code: 'git_secret_required', field: 'azure.token' } });
    // A Bitbucket access token can't become an API token by adding an email.
    const bb = settings({ bitbucket: { token: 'ATCTT3xFfGN0abcdef', email: null, setAt: 1 } });
    expect(mergeGitInput(bb, { bitbucket: { email: 'me@acme.com' } }, 5)).toEqual({ problem: { code: 'git_secret_required', field: 'bitbucket.token' } });
    expect(mergeGitInput(bb, { bitbucket: { email: null } }, 5)).toEqual({ next: bb });
  });

  it('checks every value and names the field', () => {
    const p = (input: Parameters<typeof mergeGitInput>[1]) => {
      const r = mergeGitInput(settings(), input, 1);
      return 'problem' in r ? r.problem : null;
    };
    expect(p({ github: { kind: 'token', token: 'short' } })).toMatchObject({ code: 'git_token_invalid', field: 'github.token' });
    expect(p({ github: { kind: 'token', token: 'has a space in it' } })).toMatchObject({ code: 'git_token_invalid' });
    expect(p({ github: { kind: 'app', appId: 'abc', privateKey: 'x' } })).toMatchObject({ code: 'git_app_id_invalid' });
    expect(p({ github: { kind: 'app', appId: '1', privateKey: 'not a key' } })).toMatchObject({ code: 'git_private_key_invalid' });
    expect(p({ github: { kind: 'app', appId: '1', installationId: 'x' } })).toMatchObject({ code: 'git_installation_invalid' });
    expect(p({ identity: { name: 'Bot', email: 'nope' } })).toMatchObject({ code: 'git_email_invalid', field: 'identity.email' });
    expect(p({ identity: { name: '', email: 'bot@acme.com' } })).toMatchObject({ code: 'git_identity_invalid' });
    expect(p({ identity: { name: '', email: '' } })).toBeNull(); // both empty: no identity
    expect(p({ cloneAllow: ['github.com/acme/*', 'https://github.com'] })).toEqual({ code: 'git_clone_allow_invalid', field: 'cloneAllow', entry: 'https://github.com' });
  });

  it('clone allowlist entries as Worca reads them', () => {
    expect(normalizeCloneEntry('GitHub.com/Acme/*')).toBe('github.com/acme/*');
    expect(normalizeCloneEntry('https://github.com/acme/app.git')).toBe('github.com/acme/app');
    expect(normalizeCloneEntry('dev.azure.com/org/project/*')).toBe('dev.azure.com/org/project/*');
    expect(normalizeCloneEntry('github.com/*')).toBe('github.com/*');
    for (const bad of ['github.com', 'github.com/*/app', 'github.com/a*', 'user@github.com/a', 'github.com:22/a', 'localhost/a', '1.2.3.4/a', 'github.com//a', 'github.com/../a', 'a,b/c']) {
      expect(normalizeCloneEntry(bad), bad).toBeNull();
    }
  });

  it('the variables Worca gets; nothing empty; WORCA_GH_AS_PERSON only when pushes go out as people', async () => {
    const { pkcs1Pem } = await keys;
    const s = settings({
      github: { kind: 'app', appId: '12345', privateKey: pkcs1Pem, installationId: '77', appSlug: 'a', appName: 'A', clientId: 'Iv23li', signIn: { clientSecret: 'cs-secret-1234' }, setAt: 1 },
      azure: { token: 'ado-pat-abcdefgh', setAt: 1 },
      bitbucket: { token: 'ATATT3x-abcdefgh', email: 'bot@acme.com', setAt: 1 },
      identity: { name: 'Acme Bot', email: 'bot@acme.com' },
      cloneAllow: ['github.com/acme/*', 'dev.azure.com/acme/*'],
      pushAs: 'required',
    });
    const v = gitVariables(s);
    expect(v.worca).toEqual({
      WORCA_GH_APP_ID: '12345', WORCA_GH_APP_KEY_B64: btoa(pkcs1Pem), WORCA_GH_APP_INSTALLATION_ID: '77',
      WORCA_ADO_TOKEN: 'ado-pat-abcdefgh', WORCA_BB_TOKEN: 'ATATT3x-abcdefgh', WORCA_BB_EMAIL: 'bot@acme.com',
      GIT_AUTHOR_NAME: 'Acme Bot', GIT_COMMITTER_NAME: 'Acme Bot', GIT_AUTHOR_EMAIL: 'bot@acme.com', GIT_COMMITTER_EMAIL: 'bot@acme.com',
      WORCA_CLONE_ALLOW: 'github.com/acme/*,dev.azure.com/acme/*', WORCA_GH_AS_PERSON: 'required',
    });
    expect(v.broker).toEqual({ WORCA_BROKER_GITHUB_CLIENT_ID: 'Iv23li', WORCA_BROKER_GITHUB_CLIENT_SECRET: 'cs-secret-1234' });
    for (const k of Object.keys(v.worca)) expect(WORCA_GIT_VARIABLES).toContain(k);
    for (const k of Object.keys(v.broker)) expect(BROKER_GIT_VARIABLES).toContain(k);

    expect(gitVariables(settings({ github: { kind: 'token', token: TOKEN, login: null, setAt: 1 }, pushAs: 'instance' }))).toEqual({ worca: { GH_TOKEN: TOKEN }, broker: {} });
    expect(gitVariables(settings())).toEqual({ worca: { WORCA_GH_AS_PERSON: 'prefer' }, broker: {} });
  });

  it('a passkey for adding or replacing a credential or changing the clone allowlist; not for removals, identity or pushAs', () => {
    const tok = settings({ github: { kind: 'token', token: TOKEN, login: null, setAt: 1 } });
    expect(gitNeedsMfa(settings(), tok)).toBe(true);
    expect(gitNeedsMfa(tok, { ...tok, github: { kind: 'token', token: `${TOKEN}x`, login: null, setAt: 2 } })).toBe(true);
    expect(gitNeedsMfa(tok, settings())).toBe(false);
    expect(gitNeedsMfa(tok, { ...tok, pushAs: 'required', identity: { name: 'B', email: 'b@a.co' } })).toBe(false);
    expect(gitNeedsMfa(tok, { ...tok, cloneAllow: ['github.com/acme/*'] })).toBe(true);
    expect(gitNeedsMfa({ ...tok, cloneAllow: ['github.com/acme/*'] }, tok)).toBe(true);
    const app = { kind: 'app' as const, appId: '1', privateKey: 'k', installationId: null, appSlug: null, appName: null, clientId: 'c', signIn: { clientSecret: 's' }, setAt: 1 };
    expect(gitNeedsMfa(settings({ github: app }), settings({ github: { ...app, signIn: null } }))).toBe(false);
    expect(gitNeedsMfa(settings({ github: { ...app, signIn: null } }), settings({ github: app }))).toBe(true);
    expect(gitNeedsMfa(settings(), settings({ azure: { token: 'a'.repeat(20), setAt: 1 } }))).toBe(true);
  });

  it('the view holds no secret', async () => {
    const { pkcs1Pem } = await keys;
    const s = settings({
      github: { kind: 'app', appId: '12345', privateKey: pkcs1Pem, installationId: null, appSlug: 'a', appName: 'A', clientId: 'Iv', signIn: { clientSecret: 'cs-secret-1234' }, setAt: 1 },
      azure: { token: 'ado-pat-abcdefgh', setAt: 1 },
      bitbucket: { token: 'ATATT3x-abcdefgh', email: null, setAt: 1 },
    });
    const text = JSON.stringify(gitView(s));
    for (const secret of [pkcs1Pem.slice(40, 80), 'cs-secret-1234', 'ado-pat-abcdefgh', 'ATATT3x-abcdefgh']) expect(text).not.toContain(secret);
    expect(gitView(s).azure).toEqual({ last4: 'efgh', setAt: 1 });
    expect(gitView(s).bitbucket).toMatchObject({ kind: 'access-token', last4: 'efgh' });
  });

  it('App JWTs from PKCS#1 and PKCS#8 keys verify with the public key', async () => {
    const { pkcs1Pem, pkcs8Pem } = await keys;
    expect(pkcs8Der(pkcs1Pem)).toEqual(pkcs8Der(pkcs8Pem));
    for (const k of [pkcs1Pem, pkcs8Pem]) {
      const jwt = await appJwt('12345', k, 1_700_000_000_000);
      expect(await githubApp('/app', `Bearer ${jwt}`).then((r) => r.status)).toBe(200);
      const claims = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: '12345' });
    }
  });

  it('brokerGitHash: null for none, changes with a value', async () => {
    expect(await brokerGitHash({})).toBeNull();
    const a = await brokerGitHash({ WORCA_BROKER_GITHUB_CLIENT_ID: 'x', WORCA_BROKER_GITHUB_CLIENT_SECRET: 's1' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await brokerGitHash({ WORCA_BROKER_GITHUB_CLIENT_SECRET: 's1', WORCA_BROKER_GITHUB_CLIENT_ID: 'x' })).toBe(a);
    expect(await brokerGitHash({ WORCA_BROKER_GITHUB_CLIENT_ID: 'x', WORCA_BROKER_GITHUB_CLIENT_SECRET: 's2' })).not.toBe(a);
  });
});

describe('PUT /api/orgs/:orgId/instances/:id/git', () => {
  it('a tenant admin sets a GitHub token: checked with GitHub, stored encrypted, pending, audited without the token, reconfigure started', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    githubFake.answer = githubUser();
    const res = await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, result: 'applying', git: { github: { kind: 'token', login: 'octo', last4: '9876' }, pushAs: 'prefer' } });
    expect(JSON.stringify(res.json)).not.toContain(TOKEN);
    expect(githubFake.calls).toEqual([{ path: '/user', auth: `Bearer ${TOKEN}` }]);
    const row = await instanceRow(i.id);
    expect(row).toMatchObject({ git_version: 1, git_pending: 1, pending_op: 'reconfigure' });
    expect(row!.git_settings).toMatch(/^enc:/); // through the key ring (org key)
    expect(recorded.ops).toEqual([{ op: 'reconfigure', instanceId: i.id, actorId: o.admin }]);
    expect(recorded.auditOrg).toEqual([
      { orgId: o.orgId, actorId: o.admin, actorScope: 'tenant', action: 'instance.git_updated', targetType: 'instance', targetId: i.id, details: { changes: { github: { kind: 'token', login: 'octo' } } } },
    ]);
    const view = await getGit(o.orgId, i.id, o.admin);
    expect(view.json).toMatchObject({ configured: true, version: 1, pending: true, github: { kind: 'token', login: 'octo', last4: '9876' } });
    expect(JSON.stringify(view.json)).not.toContain(TOKEN);
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin })).json.git).toEqual({ configured: true, pending: true });
  });

  it('members see who pushes go out as and whether they can sign in, nothing else; they can not change it', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    await grant(i.id, o.teamA);
    githubFake.answer = githubUser();
    await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN }, pushAs: 'required' });
    expect((await getGit(o.orgId, i.id, o.user)).json).toEqual({ pushAs: 'required', github: { kind: 'token' }, signIn: false, configured: true });
    expect((await getGit(o.orgId, i.id, o.outsider)).status).toBe(404); // can't see the instance
    expect((await putGit(o.orgId, i.id, o.user, { version: 1, github: null })).status).toBe(403);
    expect(await instanceRow(i.id)).toMatchObject({ git_version: 1 });
  });

  it('adding a credential or changing the clone allowlist needs a passkey; removing, identity and pushAs do not', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    githubFake.answer = githubUser();
    expect(await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } }, false)).toMatchObject({ status: 403, json: { error: 'mfa_required' } });
    expect(githubFake.calls).toEqual([]); // refused before asking GitHub
    expect(await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } })).toMatchObject({ status: 200, json: { result: 'saved' } });
    expect(await putGit(o.orgId, i.id, o.admin, { version: 1, pushAs: 'instance', identity: { name: 'Acme Bot', email: 'bot@acme.com' } }, false)).toMatchObject({ status: 200 });
    expect(await putGit(o.orgId, i.id, o.admin, { version: 2, cloneAllow: ['github.com/acme/*'] }, false)).toMatchObject({ status: 403 });
    expect(await putGit(o.orgId, i.id, o.admin, { version: 2, github: null }, false)).toMatchObject({ status: 200, json: { result: 'saved', git: { github: null, identity: { name: 'Acme Bot' }, pushAs: 'instance' } } });
  });

  it('a suspended or stopped instance stores it for its next start; the token kept when left out, GitHub not asked again', async () => {
    const o = await seedOrg();
    for (const status of ['suspended', 'stopped']) {
      const i = await seedInstance(o.orgId, { status });
      githubFake.answer = githubUser();
      githubFake.calls.length = 0;
      expect((await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } })).json.result).toBe('saved');
      const again = await putGit(o.orgId, i.id, o.admin, { version: 1, github: { kind: 'token' }, pushAs: 'required' });
      expect(again.json).toMatchObject({ result: 'saved', git: { github: { kind: 'token', last4: '9876', login: 'octo' }, pushAs: 'required' } });
      expect(githubFake.calls).toHaveLength(1);
      expect(await instanceRow(i.id)).toMatchObject({ git_version: 2, git_pending: 1, pending_op: null });
      expect(recorded.auditOrg.at(-1)!.details).toEqual({ changes: { pushAs: { from: 'prefer', to: 'required' } }, appliesOnStart: true });
    }
    expect(recorded.ops).toEqual([]);
  });

  it('the same configuration changes nothing; still pending on a running instance it is applied again', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    await putGit(o.orgId, i.id, o.admin, { version: 0, pushAs: 'required' });
    expect((await putGit(o.orgId, i.id, o.admin, { version: 1, pushAs: 'required' })).json.result).toBe('unchanged'); // pending, but applies on start anyway
    await E.DB.prepare(`UPDATE instances SET status = 'running', git_pending = 0 WHERE id = ?`).bind(i.id).run();
    expect((await putGit(o.orgId, i.id, o.admin, { version: 1, pushAs: 'required' })).json.result).toBe('unchanged');
    await E.DB.prepare(`UPDATE instances SET git_pending = 1 WHERE id = ?`).bind(i.id).run();
    expect((await putGit(o.orgId, i.id, o.admin, { version: 1, pushAs: 'required' })).json.result).toBe('applying');
    expect(await instanceRow(i.id)).toMatchObject({ git_version: 2, pending_op: 'reconfigure' });
    expect(recorded.auditOrg).toHaveLength(1); // only the first was a change
  });

  it('compare-and-set on the version; busy, creating and deleting instances are refused', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect(await putGit(o.orgId, i.id, o.admin, { version: 3, pushAs: 'instance' })).toMatchObject({ status: 409, json: { error: 'git_changed' } });
    for (const fields of [{ pending_op: 'suspend' }, { status: 'upgrading', target_version: '1.9.0' }, { status: 'creating' }, { status: 'deleting' }, { status: 'suspended', pending_op: 'wake' }]) {
      const b = await seedInstance(o.orgId, fields);
      expect(await putGit(o.orgId, b.id, o.admin, { version: 0, pushAs: 'instance' })).toMatchObject({ status: 409, json: { error: 'instance_busy' } });
      expect(await instanceRow(b.id)).toMatchObject({ git_version: 0, git_settings: null });
    }
    expect(recorded.auditOrg).toEqual([]);
  });

  it('refusals name the field; nothing stored', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    expect((await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: 'short' } })).json).toEqual({ error: 'git_token_invalid', field: 'github.token' });
    expect((await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'app', appId: '1' } })).json).toEqual({ error: 'git_secret_required', field: 'github.privateKey' });
    expect((await putGit(o.orgId, i.id, o.admin, { version: 0, cloneAllow: ['github.com'] })).json).toEqual({ error: 'git_clone_allow_invalid', field: 'cloneAllow', entry: 'github.com' });
    for (const body of [{}, { version: 0, github: { kind: 'ssh' } }, { version: 0, pushAs: 'everyone' }, { version: 0, extra: 1 }, { version: 0, github: { kind: 'token', token: TOKEN, login: 'x' } }]) {
      expect((await putGit(o.orgId, i.id, o.admin, body)).json).toEqual({ error: 'invalid_body' });
    }
    githubFake.answer = () => new Response('Bad credentials', { status: 401 });
    expect(await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } })).toMatchObject({ status: 422, json: { error: 'git_token_rejected', field: 'github.token' } });
    githubFake.answer = () => new Response('down', { status: 503 });
    expect(await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } })).toMatchObject({ status: 502, json: { error: 'git_check_failed' } });
    githubFake.answer = () => { throw new TypeError('network'); };
    expect(await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'token', token: TOKEN } })).toMatchObject({ status: 502, json: { error: 'git_check_failed' } });
    expect(await instanceRow(i.id)).toMatchObject({ git_version: 0, git_settings: null, pending_op: null });
  });

  it("the org's own GitHub App: the key checked against the App, its installation, and its client ID for members' sign-in", async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    const { pkcs1Pem } = await keys;
    githubFake.answer = (path, auth) => githubApp(path, auth);
    const res = await putGit(o.orgId, i.id, o.admin, { version: 0, github: { kind: 'app', appId: '12345', privateKey: pkcs1Pem, signIn: { clientSecret: 'cs-0123456789abcdef' } } });
    expect(res.json).toMatchObject({
      result: 'saved',
      git: { github: { kind: 'app', appId: '12345', installationId: null, appSlug: 'acme-worca', appName: 'Acme Worca', clientId: 'Iv23liAcme0001', signIn: true } },
    });
    expect(githubFake.calls.map((c) => c.path)).toEqual(['/app', '/app/installations?per_page=1']);
    expect(JSON.stringify(res.json)).not.toContain('cs-0123456789abcdef');
    expect((await getGit(o.orgId, i.id, o.admin)).json.signIn).toBe(true);

    // Sign-in off on the same App: no passkey, no new check.
    githubFake.calls.length = 0;
    const off = await putGit(o.orgId, i.id, o.admin, { version: 1, github: { kind: 'app', appId: '12345', signIn: null } }, false);
    expect(off.json).toMatchObject({ result: 'saved', git: { github: { signIn: false, clientId: 'Iv23liAcme0001' } } });
    expect(githubFake.calls).toEqual([]);
  });

  it('the App check refuses a key of another App, an installation that is not there, and an App installed nowhere', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended' });
    const { pkcs8Pem } = await keys;
    const body = (extra = {}) => ({ version: 0, github: { kind: 'app', appId: '12345', privateKey: pkcs8Pem, ...extra } });
    githubFake.answer = (path, auth) => githubApp(path, auth, { id: 999 });
    expect((await putGit(o.orgId, i.id, o.admin, body())).json).toEqual({ error: 'git_app_rejected', field: 'github.appId' });
    githubFake.answer = () => new Response('', { status: 401 });
    expect((await putGit(o.orgId, i.id, o.admin, body())).json).toEqual({ error: 'git_app_rejected', field: 'github.privateKey' });
    githubFake.answer = (path, auth) => githubApp(path, auth, { installation: false });
    expect((await putGit(o.orgId, i.id, o.admin, body({ installationId: '5' }))).json).toEqual({ error: 'git_installation_not_found', field: 'github.installationId' });
    githubFake.answer = (path, auth) => githubApp(path, auth, { installations: [] });
    expect((await putGit(o.orgId, i.id, o.admin, body())).json).toEqual({ error: 'git_app_not_installed', field: 'github.installationId' });
    githubFake.answer = (path, auth) => githubApp(path, auth);
    expect((await putGit(o.orgId, i.id, o.admin, body({ installationId: '77' }))).json).toMatchObject({ result: 'saved', git: { github: { installationId: '77' } } });
  });
});

describe('applied by the operations', () => {
  async function seedConfigured(fields: Record<string, string | number | null>, s: GitSettings) {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { git_settings: `enc:${JSON.stringify(s)}`, git_version: 2, git_pending: 1, ...fields });
    return { o, i };
  }
  const tokenOnly = () => settings({ github: { kind: 'token', token: TOKEN, login: 'octo', setAt: 1 }, identity: { name: 'Bot', email: 'bot@acme.com' } });
  const withSignIn = () =>
    settings({ github: { kind: 'app', appId: '12345', privateKey: 'k', installationId: null, appSlug: 'a', appName: 'A', clientId: 'Iv23li', signIn: { clientSecret: 'cs-1' }, setAt: 1 } });

  it('reconfigure writes the git variables (names only reach the stub), restarts worca, clears pending', async () => {
    const { i } = await seedConfigured({ pending_op: 'reconfigure' }, tokenOnly());
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub);
    expect(await runOp(ctx, { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect(stub.calls.map((c) => `${c.method} ${c.path.split('/').at(-1)}`)).toEqual(['POST variables', 'POST variables', 'POST deploy', `GET ${i.id}`]);
    expect(stub.calls[1]!.body).toEqual({ variables: { git: { worca: ['GH_TOKEN', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME', 'WORCA_GH_AS_PERSON'], broker: [] } } });
    expect(JSON.stringify(stub.calls)).not.toContain(TOKEN);
    expect(ctx.steps.names).not.toContain('restart key page');
    expect(await instanceRow(i.id)).toMatchObject({ pending_op: null, git_pending: 0, git_broker_applied: null });
  });

  it("the key page restarts when the members' GitHub sign-in changed, and only then", async () => {
    const { i } = await seedConfigured({ pending_op: 'reconfigure' }, withSignIn());
    const ctx = opsCtx(fakeStubFetch());
    expect(await runOp(ctx, { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    expect(ctx.steps.names).toContain('restart key page');
    const hash = await brokerGitHash({ WORCA_BROKER_GITHUB_CLIENT_ID: 'Iv23li', WORCA_BROKER_GITHUB_CLIENT_SECRET: 'cs-1' });
    expect(await instanceRow(i.id)).toMatchObject({ git_pending: 0, git_broker_applied: hash });

    // Applied again (another setting changed): the broker already has it.
    await E.DB.prepare(`UPDATE instances SET pending_op = 'reconfigure', remote_pending = 1, terminal_remote = 1 WHERE id = ?`).bind(i.id).run();
    const again = opsCtx(fakeStubFetch());
    await runOp(again, { op: 'reconfigure', instanceId: i.id });
    expect(again.steps.names).not.toContain('restart key page');
  });

  it('a git change saved while the reconfigure ran stays pending (version compare)', async () => {
    const { i } = await seedConfigured({ pending_op: 'reconfigure' }, tokenOnly());
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub);
    // Between the variables and the restart, an admin saves again (the version moves on).
    const real = ctx.providers.compute.restartWorca.bind(ctx.providers.compute);
    let bumped = false;
    ctx.providers.compute.restartWorca = async (ref) => {
      if (!bumped) {
        bumped = true;
        await E.DB.prepare(`UPDATE instances SET git_version = git_version + 1, git_pending = 1 WHERE id = ?`).bind(i.id).run();
      }
      return real(ref);
    };
    expect(await runOp(ctx, { op: 'reconfigure', instanceId: i.id })).toEqual({ ok: true, outcome: 'applied' });
    // The second round applied version 3.
    expect(ctx.steps.names.filter((n) => n.startsWith('set worca settings'))).toEqual(['set worca settings', 'set worca settings (2)']);
    expect(await instanceRow(i.id)).toMatchObject({ git_version: 3, git_pending: 0, pending_op: null });
  });

  it('wake applies pending git settings and starts worca from its configuration; never-configured instances get no git write', async () => {
    const { i } = await seedConfigured({ status: 'suspended', pending_op: 'wake' }, tokenOnly());
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential))), { op: 'wake', instanceId: i.id })).toEqual({ ok: true, outcome: 'running' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'variables', 'start']);
    expect(await instanceRow(i.id)).toMatchObject({ status: 'running', git_pending: 0 });

    // Configured from the console, then everything removed: still managed, so the credentials go
    // (only the default "push as the person who acted" stays, harmless without a credential).
    const { i: cleared } = await seedConfigured({ pending_op: 'reconfigure', git_settings: null }, tokenOnly());
    const stub2 = fakeStubFetch();
    await runOp(opsCtx(stub2), { op: 'reconfigure', instanceId: cleared.id });
    expect(stub2.calls[1]!.body).toEqual({ variables: { git: { worca: ['WORCA_GH_AS_PERSON'], broker: [] } } });
  });
});

describe("members' own GitHub by default (no git settings saved)", () => {
  it('create sets WORCA_GH_AS_PERSON=prefer; a reconfigure keeps it; once an admin saves git settings they manage it', async () => {
    const o = await seedOrg();
    const created = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const stub = fakeStubFetch();
    const ctx = opsCtx(stub, async () => {
      const vars = stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables;
      await sendBeat(vars.heartbeatCredential, beat({ version: '1.9.0' }));
    });
    await runOp(ctx, { op: 'create', instanceId: created.json.id });
    expect(stub.calls.find((c) => c.path.endsWith('/variables'))!.body.variables).toMatchObject({ ghAsPerson: 'prefer' });

    const i = await seedInstance(o.orgId, { pending_op: 'reconfigure', remote_pending: 1 });
    const s1 = fakeStubFetch();
    await runOp(opsCtx(s1), { op: 'reconfigure', instanceId: i.id });
    expect(s1.calls[0]!.body.variables.ghAsPerson).toBe('prefer');
    expect(s1.calls.filter((c) => c.path.endsWith('/variables'))).toHaveLength(1); // no git write: not managed

    const saved = await seedInstance(o.orgId, { pending_op: 'reconfigure', git_settings: `enc:${JSON.stringify(settings({ pushAs: 'instance' }))}`, git_version: 1, git_pending: 1 });
    const s2 = fakeStubFetch();
    await runOp(opsCtx(s2), { op: 'reconfigure', instanceId: saved.id });
    expect(s2.calls[0]!.body.variables.ghAsPerson).toBeUndefined();
    expect(s2.calls[1]!.body).toEqual({ variables: { git: { worca: [], broker: [] } } }); // WORCA_GH_AS_PERSON removed
  });

  it('existing instances (migration 0030) get it on their next start; the consoles never show the default as "not applied"', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId, { status: 'suspended', pending_op: 'wake', git_pending: 1 });
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${i.id}`, { user: o.admin })).json.git).toEqual({ configured: false, pending: false });
    expect((await getGit(o.orgId, i.id, o.admin)).json).toMatchObject({ configured: false, pending: false, pushAs: 'prefer', version: 0 });
    const stub = fakeStubFetch();
    expect(await runOp(opsCtx(stub, async () => void (await sendBeat(i.credential))), { op: 'wake', instanceId: i.id })).toEqual({ ok: true, outcome: 'running' });
    expect(stub.calls.map((c) => c.path.split('/').at(-1))).toEqual(['variables', 'start']);
    expect(stub.calls[0]!.body.variables.ghAsPerson).toBe('prefer');
    expect(await instanceRow(i.id)).toMatchObject({ git_pending: 0, git_version: 0 });
  });

  it('members see "Your GitHub" data even without a credential of the instance', async () => {
    const o = await seedOrg();
    const i = await seedInstance(o.orgId);
    await grant(i.id, o.teamA);
    expect((await getGit(o.orgId, i.id, o.user)).json).toEqual({ pushAs: 'prefer', github: null, signIn: false, configured: false });
  });
});

describe('railway provider: git credentials', () => {
  const env = { RAILWAY_TOKEN: 'rw-token', RAILWAY_WORKSPACE_ID: 'ws-1', RESOURCE_PREFIX: 'worca-run-' } as unknown as Env;
  const ref: ComputeRef = {
    projectId: 'proj-1',
    environmentId: 'env-1',
    services: { worca: { serviceId: 'svc-worca' }, broker: { serviceId: 'svc-broker' }, cloudflared: { serviceId: 'svc-cloudflared' } },
  };
  function fakeRailway(o: { held?: Record<string, Record<string, string>>; sticky?: string[] } = {}) {
    const calls: { op: string; variables: Record<string, any> }[] = [];
    const held: Record<string, Record<string, string>> = { 'svc-worca': { OTHER: 'keep' }, 'svc-broker': {}, ...o.held };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.operationName === 'projectName') return Response.json({ data: { project: { id: 'proj-1', name: 'worca-run-0123456789abcdef012345' } } });
      calls.push({ op: body.operationName, variables: body.variables });
      const svc = body.variables?.input?.serviceId ?? body.variables?.serviceId;
      if (body.operationName === 'variableCollectionUpsert') {
        held[svc] = { ...held[svc], ...body.variables.input.variables };
        return Response.json({ data: { variableCollectionUpsert: true } });
      }
      if (body.operationName === 'variableDelete') {
        if (!o.sticky?.includes(body.variables.input.name)) delete held[svc]![body.variables.input.name];
        return Response.json({ data: { variableDelete: true } });
      }
      if (body.operationName === 'variables') return Response.json({ data: { variables: held[svc] } });
      if (body.operationName === 'serviceInstanceDeployV2') return Response.json({ data: { serviceInstanceDeployV2: `dep-${body.variables.serviceId}` } });
      if (body.operationName === 'latestDeployment') return Response.json({ data: { deployments: { edges: [{ node: { id: `dep-${body.variables.input.serviceId}`, status: 'SUCCESS', deploymentStopped: true } }] } } });
      if (body.operationName === 'deploymentRedeploy') return Response.json({ data: { deploymentRedeploy: { id: `re-${body.variables.id}`, status: 'INITIALIZING' } } });
      throw new Error(`unexpected ${body.operationName}`);
    }) as unknown as typeof fetch;
    return { calls, held, provider: createRailwayProvider(env, fetchImpl, { sleep: async () => {} }) };
  }

  it('gitDiff: only changed values are written, managed names no longer wanted go, others stay', () => {
    expect(gitDiff({ GH_TOKEN: 'a', WORCA_GH_READ_TOKEN: 'r', OTHER: 'x' }, { GH_TOKEN: 'a', WORCA_ADO_TOKEN: 'b' }, WORCA_GIT_VARIABLES)).toEqual({
      upsert: { WORCA_ADO_TOKEN: 'b' },
      remove: ['WORCA_GH_READ_TOKEN'],
    });
  });

  it('setGitSettings writes worca and broker, removes stale credentials (a hand-set pair too), reads both back', async () => {
    const { calls, held, provider } = fakeRailway({ held: { 'svc-worca': { OTHER: 'keep', GH_TOKEN: 'old', WORCA_GH_WRITE_TOKEN: 'w' } } });
    await provider.setGitSettings(ref, { worca: { WORCA_GH_APP_ID: '1', WORCA_GH_APP_KEY_B64: 'a2V5' }, broker: { WORCA_BROKER_GITHUB_CLIENT_ID: 'Iv', WORCA_BROKER_GITHUB_CLIENT_SECRET: 's' } });
    expect(calls.map((c) => `${c.op} ${c.variables.input?.name ?? c.variables.input?.serviceId ?? c.variables.serviceId}`)).toEqual([
      'variables svc-worca',
      'variableCollectionUpsert svc-worca',
      'variableDelete GH_TOKEN',
      'variableDelete WORCA_GH_WRITE_TOKEN',
      'variables svc-broker',
      'variableCollectionUpsert svc-broker',
      'variables svc-worca',
      'variables svc-broker',
    ]);
    expect(calls[1]!.variables.input.skipDeploys).toBe(true);
    expect(held['svc-worca']).toEqual({ OTHER: 'keep', WORCA_GH_APP_ID: '1', WORCA_GH_APP_KEY_B64: 'a2V5' });
    expect(held['svc-broker']).toEqual({ WORCA_BROKER_GITHUB_CLIENT_ID: 'Iv', WORCA_BROKER_GITHUB_CLIENT_SECRET: 's' });
  });

  it('setGitSettings fails naming the variable, never a value, when a stale one survives', async () => {
    const { provider } = fakeRailway({ held: { 'svc-worca': { GH_TOKEN: 'ghp_secretvalue' } }, sticky: ['GH_TOKEN'] });
    const err = await provider.setGitSettings(ref, { worca: {}, broker: {} }).catch((e: Error) => e);
    expect(String(err)).toMatch(/not confirmed: worca GH_TOKEN \(still set\)$/);
    expect(String(err)).not.toContain('ghp_secretvalue');
  });

  it('restartBroker deploys the broker only; start can deploy the broker from its configuration', async () => {
    const { calls, provider } = fakeRailway();
    const out = await provider.restartBroker(ref);
    expect(calls).toEqual([{ op: 'serviceInstanceDeployV2', variables: { serviceId: 'svc-broker', environmentId: 'env-1' } }]);
    expect(out.services.broker).toEqual({ serviceId: 'svc-broker', deploymentId: 'dep-svc-broker' });
    calls.length = 0;
    await provider.start(ref, { worcaFromConfig: true, brokerFromConfig: true });
    expect(calls.map((c) => `${c.op} ${c.variables.serviceId ?? c.variables.input?.serviceId ?? c.variables.id}`)).toEqual([
      'serviceInstanceDeployV2 svc-worca',
      'serviceInstanceDeployV2 svc-broker',
      'latestDeployment svc-cloudflared',
      'deploymentRedeploy dep-svc-cloudflared',
    ]);
  });
});

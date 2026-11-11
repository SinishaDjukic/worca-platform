// Shared fixtures for the instances tests: seeded org/users/teams, fake deps, a test app, and an
// immediate StepRunner for the ops.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import type { AppContext, Env } from '../../../packages/platform/src/control/env';
import { sha256Hex, type KeyRing } from '../../../packages/platform/src/control/keys-api';
import { randomSlug, setOpRestarter, setOpStarter, type OpParams } from '../../../packages/platform/src/control/instances/api';
import { setProviderRefresher, setReleaseChecker } from '../../../packages/platform/src/control/instances/crons';
import { setInstancesDeps, type AuditOrgEntry, type AuditPlatformEntry } from '../../../packages/platform/src/control/instances/deps';
import { heartbeatApp, instancesApp } from '../../../packages/platform/src/control/instances/routes';
import type { StepRunner } from '../../../packages/platform/src/control/instances/ops';

export const E = env as unknown as Env;

export interface GateFake {
  calls(): Promise<unknown[][]>;
  reset(): Promise<void>;
  hosts(): Promise<Record<string, unknown>>;
  setState(instanceId: string, patch: { lastVisit?: number | null; unreadable?: boolean }): Promise<void>;
}
export const gateFake = () => env.GATE as unknown as GateFake;

/** Reversible stand-in for the key ring: `enc:` + plaintext. */
export const fakeKeyRing = {
  async ensureKey() {},
  async encrypt(_ctx, plaintext) {
    return `enc:${plaintext}`;
  },
  async decrypt(_ctx, ciphertext) {
    return ciphertext.replace(/^enc:/, '');
  },
  isCiphertext: (v) => typeof v === 'string' && v.startsWith('enc:'),
  async blindIndex(v) {
    return v;
  },
  async emailIndex(v) {
    return v;
  },
  async destroyKey() {},
  async rotateOrgKey() {
    return 2;
  },
} satisfies KeyRing;

export const recorded = {
  ops: [] as OpParams[],
  mails: [] as { to: string; subject: string; text: string }[],
  auditOrg: [] as (AuditOrgEntry & { orgId: string })[],
  auditPlatform: [] as AuditPlatformEntry[],
  confirmations: [] as { userId: string; orgId: string; action: string; target: string; summary: string }[],
  restarts: [] as string[],
  providerPolls: 0,
};

/**
 * D79: GitHub as the git-credential check sees it. `answer` decides each response (null: no answer
 * set, the test fails loudly); `calls` holds the paths and the authorization header's scheme.
 */
export const githubFake = {
  answer: null as null | ((path: string, auth: string) => Response | Promise<Response>),
  calls: [] as { path: string; auth: string }[],
};

export function installFakes(): void {
  githubFake.answer = null;
  githubFake.calls.length = 0;
  recorded.ops.length = 0;
  recorded.mails.length = 0;
  recorded.auditOrg.length = 0;
  recorded.auditPlatform.length = 0;
  recorded.confirmations.length = 0;
  recorded.restarts.length = 0;
  recorded.providerPolls = 0;
  setOpRestarter(async (_env, id) => void recorded.restarts.push(id));
  // The 5-minute cron polls the providers; never over the network in unit tests.
  setProviderRefresher(async () => void recorded.providerPolls++);
  setReleaseChecker(async () => undefined); // nor asks npm and GHCR for releases (D77)
  setOpStarter(async (_env, p) => {
    recorded.ops.push(p);
    return `test-${p.op}`;
  });
  setInstancesDeps({
    getKeyRing: () => fakeKeyRing,
    auditOrg: async (_env, orgId, e) => void recorded.auditOrg.push({ ...e, orgId }),
    auditPlatform: async (_env, e) => void recorded.auditPlatform.push(e),
    sendEmail: async (_env, m) => void recorded.mails.push(m),
    startConfirmation: async (_env, input) => {
      recorded.confirmations.push(input);
      return { id: 'c1', expiresAt: Date.now() + 1 };
    },
    // Signed in as the user named by x-test-user (a passkey session unless x-test-mfa: 0);
    // requireOrgRole stays the real tenancy one.
    githubFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      githubFake.calls.push({ path: `${url.pathname}${url.search}`, auth });
      if (!githubFake.answer) throw new Error(`unexpected GitHub call ${url.pathname}`);
      return githubFake.answer(`${url.pathname}${url.search}`, auth);
    }) as typeof fetch,
    requireSession: async (c, next) => {
      const id = c.req.header('x-test-user');
      if (!id) return c.json({ error: 'unauthenticated' }, 401);
      c.set('user', { id, email: `${id}@example.com`, name: id, status: 'active' });
      const mfa = c.req.header('x-test-mfa') !== '0';
      c.set('session', { id: `s-${id}`, userId: id, method: mfa ? 'passkey' : 'email-otp', mfa, expiresAt: Date.now() + 3_600_000, activeOrganizationId: null, ssoOrgId: null });
      await next();
    },
  });
}

export function testApp() {
  const app = new Hono<AppContext>();
  app.route('/api/heartbeat', heartbeatApp);
  app.route('/api/orgs', instancesApp);
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: err.message }, status as 400);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });
  return {
    async call(method: string, path: string, opts: { user?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
      if (opts.user) headers['x-test-user'] = opts.user;
      const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, E);
      const json = (await res.json().catch(() => null)) as Record<string, any> | null;
      return { status: res.status, json: json ?? {} };
    },
  };
}

const uid = () => crypto.randomUUID();

export interface Org {
  orgId: string;
  admin: string;
  user: string; // tenant user in teamA only
  both: string; // tenant user in teamA and teamB
  outsider: string; // member in no team
  teamA: string;
  teamB: string;
}

export async function seedOrg(): Promise<Org> {
  const o: Org = { orgId: uid(), admin: uid(), user: uid(), both: uid(), outsider: uid(), teamA: uid(), teamB: uid() };
  const now = Date.now();
  const stmts = [
    E.DB.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Acme', ?, ?)`).bind(o.orgId, o.orgId, now),
  ];
  for (const [id, role] of [
    [o.admin, 'tenant_admin'],
    [o.user, 'tenant_user'],
    [o.both, 'tenant_user'],
    [o.outsider, 'tenant_user'],
  ] as const) {
    stmts.push(
      E.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, status) VALUES (?, ?, ?, 1, ?, ?, 'active')`).bind(
        id, id, `${id}@example.com`, now, now,
      ),
      E.DB.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`).bind(uid(), o.orgId, id, role, now),
    );
  }
  for (const t of [o.teamA, o.teamB]) {
    stmts.push(E.DB.prepare(`INSERT INTO team (id, name, memberCount, organizationId, createdAt) VALUES (?, 'enc:t', 0, ?, ?)`).bind(t, o.orgId, now));
  }
  for (const [team, user] of [
    [o.teamA, o.user],
    [o.teamA, o.both],
    [o.teamB, o.both],
  ]) {
    stmts.push(E.DB.prepare(`INSERT INTO teamMember (id, teamId, userId, createdAt) VALUES (?, ?, ?, ?)`).bind(uid(), team, user, now));
  }
  await E.DB.batch(stmts);
  return o;
}

/** Inserts an instance row directly, in any status. */
export async function seedInstance(
  orgId: string,
  fields: Partial<Record<string, string | number | null>> = {},
): Promise<{ id: string; slug: string; keySlug: string; credential: string }> {
  const id = uid();
  const slug = randomSlug();
  const keySlug = randomSlug();
  const credential = `cred-${id}`;
  const row: Record<string, unknown> = {
    id, org_id: orgId, slug, key_slug: keySlug, display_name: 'enc:Main', status: 'running', worca_version: '1.8.0',
    compute_ref: JSON.stringify({ projectId: id, services: { worca: { serviceId: 'w' }, broker: { serviceId: 'b' }, cloudflared: { serviceId: 'c' } } }),
    edge_ref: JSON.stringify({ tunnelId: `t-${id}`, dnsRecordIds: ['d1', 'd2'] }),
    cpu: 2, memory_mb: 4096, volume_gb: 10, heartbeat_cred_hash: await sha256Hex(credential), health: 'ok',
    last_heartbeat_at: Date.now(), created_at: Date.now(), updated_at: Date.now(), ...fields,
  };
  const cols = Object.keys(row);
  await E.DB.prepare(`INSERT INTO instances (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(row)).run();
  return { id, slug, keySlug, credential };
}

export async function instanceRow(id: string) {
  return E.DB.prepare(`SELECT * FROM instances WHERE id = ?`).bind(id).first<Record<string, any>>();
}

/** Runs steps at once; `onSleep` lets a test deliver a heartbeat while the op "waits". */
export function immediateSteps(onSleep?: (name: string) => Promise<void>): StepRunner & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    async do(name, fn) {
      names.push(name);
      return fn();
    },
    async sleep(name) {
      names.push(name);
      await onSleep?.(name);
    },
  };
}

/** Records calls to the stub admin API and answers like the stub. */
export function fakeStubFetch() {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    // A GET of one instance answers as the stub does for a running one (the reconfigure op's deployment check).
    if ((init?.method ?? 'GET') === 'GET') return Response.json({ ok: true, state: 'running' });
    return Response.json({ ok: true }, { status: init?.method === 'POST' && url.pathname === '/__admin/instances' ? 201 : 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export function beat(overrides: Record<string, unknown> = {}) {
  return { health: 'ok', version: '1.8.0', pipelines: { running: 0, queued: 0 }, nextScheduledAt: null, suspendable: true, ...overrides };
}

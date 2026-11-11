// Fixtures for the tenancy tests: tables other modules own (created only if their migrations
// haven't), a fake KeyRing, fake auth/instances/email seams, seed helpers and a harness app
// that stands in for the auth middleware (the signed-in user comes from a test header).
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import type { AppContext, Env, SessionInfo, SessionUser } from '../../../../packages/platform/src/control/env';
import { KeyDestroyedError, sha256Hex, type FieldContext, type KeyOwner, type KeyRing } from '../../../../packages/platform/src/control/keys-api';
import { confirmApp } from '../../../../packages/platform/src/control/tenancy/confirmations';
import { resetTenancyDeps, setTenancyDeps, type EmailMessage } from '../../../../packages/platform/src/control/tenancy/deps';
import { meApp } from '../../../../packages/platform/src/control/tenancy/me-routes';
import { platformApp } from '../../../../packages/platform/src/control/tenancy/platform-routes';
import { tenantApp } from '../../../../packages/platform/src/control/tenancy/routes';

export const testEnv = env as unknown as Env;

// ---- tables owned by auth (0001) and instances (0005), when those aren't there yet ------------

const OTHER_TABLES = [
  `CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, emailIndex TEXT, emailVerified INTEGER NOT NULL DEFAULT 1, image TEXT, status TEXT NOT NULL DEFAULT 'active', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, userId TEXT NOT NULL, token TEXT NOT NULL, expiresAt TEXT NOT NULL, activeOrganizationId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, userId TEXT NOT NULL, accountId TEXT NOT NULL, providerId TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, logo TEXT, metadata TEXT, createdAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL, createdAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invitation (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, email TEXT NOT NULL, emailIndex TEXT, role TEXT, status TEXT NOT NULL, teamId TEXT, inviterId TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS team (id TEXT PRIMARY KEY, name TEXT NOT NULL, organizationId TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT)`,
  `CREATE TABLE IF NOT EXISTS teamMember (id TEXT PRIMARY KEY, teamId TEXT NOT NULL, userId TEXT NOT NULL, createdAt TEXT)`,
  `CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, key_slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, status TEXT NOT NULL, worca_version TEXT, available_version TEXT, compute_ref TEXT, edge_ref TEXT, cpu REAL, memory_mb INTEGER, volume_gb INTEGER, stopped_reason TEXT, stopped_by TEXT, heartbeat_cred_hash TEXT UNIQUE, health TEXT, last_heartbeat_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS instance_teams (instance_id TEXT NOT NULL, team_id TEXT NOT NULL, role TEXT, PRIMARY KEY (instance_id, team_id))`,
];

export async function ensureTables(): Promise<void> {
  for (const sql of OTHER_TABLES) await testEnv.DB.prepare(sql).run();
}

/** Inserts only the columns the table has, so seeds survive the real migrations' extra columns. */
export async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = (await testEnv.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  await testEnv.DB.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .bind(...keys.map((k) => row[k] ?? null))
    .run();
}

// ---- fake KeyRing -----------------------------------------------------------------------------

const ownerKey = (o: KeyOwner) => `${o.type}:${o.id}`;
const ctxKey = (c: FieldContext) => `${c.table}.${c.column}.${c.rowId}.${ownerKey(c.owner)}`;

export class FakeKeyRing implements KeyRing {
  destroyed = new Set<string>();
  ensured = new Set<string>();
  versions = new Map<string, number>();
  async ensureKey(owner: KeyOwner) {
    this.ensured.add(ownerKey(owner));
  }
  async encrypt(ctx: FieldContext, plaintext: string) {
    if (this.destroyed.has(ownerKey(ctx.owner))) throw new KeyDestroyedError(ctx.owner);
    return `enc:v1:${btoa(JSON.stringify([ctxKey(ctx), plaintext]))}`;
  }
  async decrypt(ctx: FieldContext, ciphertext: string) {
    if (this.destroyed.has(ownerKey(ctx.owner))) throw new KeyDestroyedError(ctx.owner);
    const [bound, plain] = JSON.parse(atob(ciphertext.slice('enc:v1:'.length))) as [string, string];
    if (bound !== ctxKey(ctx)) throw new Error('aad mismatch');
    return plain;
  }
  isCiphertext(value: unknown) {
    return typeof value === 'string' && value.startsWith('enc:v1:');
  }
  async blindIndex(value: string) {
    return sha256Hex(`bi:${value}`);
  }
  async emailIndex(email: string) {
    return this.blindIndex(email.trim().toLowerCase());
  }
  async destroyKey(owner: KeyOwner) {
    this.destroyed.add(ownerKey(owner));
  }
  async rotateOrgKey(orgId: string) {
    const v = (this.versions.get(orgId) ?? 1) + 1;
    this.versions.set(orgId, v);
    return v;
  }
}

// ---- fake seams -------------------------------------------------------------------------------

export interface Fakes {
  ring: FakeKeyRing;
  mail: EmailMessage[];
  instanceCalls: [string, string, unknown][];
  dns: Map<string, string[]>;
}

export function installFakes(): Fakes {
  const ring = new FakeKeyRing();
  const fakes: Fakes = { ring, mail: [], instanceCalls: [], dns: new Map() };
  resetTenancyDeps();
  setTenancyDeps({
    keyRing: () => ring,
    sendEmail: async (_env, msg) => {
      fakes.mail.push(msg);
    },
    auth: {
      async createOrganization(e, { userId, name, slug }) {
        const id = crypto.randomUUID();
        await insertRow('organization', { id, name: await ring.encrypt(orgField(id), name), slug, createdAt: new Date().toISOString() });
        await insertRow('member', { id: crypto.randomUUID(), organizationId: id, userId, role: 'tenant_admin', createdAt: new Date().toISOString() });
        void e;
        return { id };
      },
      async createInvitation(e, { orgId, email, role, teamId }) {
        const inviter = await e.DB.prepare("SELECT userId FROM member WHERE organizationId = ? AND role = 'tenant_admin' LIMIT 1").bind(orgId).first<{ userId: string }>();
        const id = crypto.randomUUID();
        const expiresAt = Date.now() + 7 * 86_400_000;
        await insertRow('invitation', {
          id,
          organizationId: orgId,
          email: await ring.encrypt({ table: 'invitation', column: 'email', rowId: id, owner: { type: 'org', id: orgId } }, email),
          emailIndex: await ring.emailIndex(email),
          role,
          status: 'pending',
          teamId: teamId ?? null,
          inviterId: inviter?.userId,
          expiresAt: new Date(expiresAt).toISOString(),
          createdAt: new Date().toISOString(),
        });
        return { id, expiresAt };
      },
      async registerSsoProvider(e, { orgId, providerId, domain, issuer }) {
        const admin = await e.DB.prepare("SELECT userId FROM member WHERE organizationId = ? AND role = 'tenant_admin' LIMIT 1").bind(orgId).first<{ userId: string }>();
        const id = `sso_${providerId}`;
        await insertRow('ssoProvider', {
          id,
          issuer,
          userId: admin?.userId,
          providerId,
          organizationId: orgId,
          domain: 'enc',
          domainIndex: await ring.blindIndex(domain.trim().toLowerCase()),
          domainVerified: 1,
        });
        return { id };
      },
    },
    instances: {
      async stopForAbuse(_e, id, input) {
        fakes.instanceCalls.push(['stopForAbuse', id, input]);
      },
      async liftStop(_e, id, input) {
        fakes.instanceCalls.push(['liftStop', id, input]);
      },
      async deleteInstanceNow(e, id, input) {
        fakes.instanceCalls.push(['deleteInstanceNow', id, input]);
        await e.DB.prepare('DELETE FROM instances WHERE id = ?').bind(id).run();
      },
    },
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const records = fakes.dns.get(url.searchParams.get('name') ?? '') ?? [];
      return Response.json({ Status: 0, Answer: records.map((r) => ({ type: 16, data: `"${r}"` })) });
    },
  });
  return fakes;
}

const orgField = (id: string): FieldContext => ({ table: 'organization', column: 'name', rowId: id, owner: { type: 'org', id } });

// ---- seeds ------------------------------------------------------------------------------------

export interface TestUser extends SessionUser {}

export async function seedUser(
  fakes: Fakes,
  opts: { email?: string; name?: string; status?: SessionUser['status']; registeredVia?: string } = {},
): Promise<TestUser> {
  const id = crypto.randomUUID();
  const email = opts.email ?? `${id.slice(0, 8)}@example.com`;
  const name = opts.name ?? `User ${id.slice(0, 4)}`;
  const now = new Date().toISOString();
  const owner: KeyOwner = { type: 'user', id };
  await insertRow('user', {
    id,
    email: await fakes.ring.encrypt({ table: 'user', column: 'email', rowId: id, owner }, email),
    emailIndex: await fakes.ring.emailIndex(email),
    name: await fakes.ring.encrypt({ table: 'user', column: 'name', rowId: id, owner }, name),
    emailVerified: 1,
    status: opts.status ?? 'active',
    registeredVia: opts.registeredVia ?? 'code',
    createdAt: now,
    updatedAt: now,
  });
  return { id, email, name, status: opts.status ?? 'active' };
}

export async function seedOrg(fakes: Fakes, admin: TestUser, name = 'Acme'): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow('organization', { id, name: await fakes.ring.encrypt(orgField(id), name), slug: id.slice(0, 10), createdAt: new Date().toISOString() });
  await addMember(id, admin, 'tenant_admin');
  await testEnv.DB.prepare('INSERT INTO org_settings (org_id, tier, status, created_at) VALUES (?, ?, ?, ?)').bind(id, 'free', 'active', Date.now()).run();
  return id;
}

export async function addMember(orgId: string, user: TestUser, role: 'tenant_admin' | 'tenant_user' = 'tenant_user'): Promise<void> {
  await insertRow('member', { id: crypto.randomUUID(), organizationId: orgId, userId: user.id, role, createdAt: new Date().toISOString() });
}

export async function seedTeam(fakes: Fakes, orgId: string, name = 'Team', members: TestUser[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await insertRow('team', {
    id,
    name: await fakes.ring.encrypt({ table: 'team', column: 'name', rowId: id, owner: { type: 'org', id: orgId } }, name),
    organizationId: orgId,
    memberCount: members.length,
    createdAt: now,
    updatedAt: now,
  });
  for (const m of members) await insertRow('teamMember', { id: crypto.randomUUID(), teamId: id, userId: m.id, createdAt: now });
  return id;
}

export async function seedInstance(orgId: string, opts: { status?: string; teams?: string[] } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await insertRow('instances', {
    id,
    org_id: orgId,
    slug: id.slice(0, 10),
    key_slug: id.slice(-10),
    display_name: 'enc',
    status: opts.status ?? 'running',
    worca_version: '1.8.0',
    health: 'ok',
    created_at: now,
    updated_at: now,
  });
  for (const t of opts.teams ?? []) await testEnv.DB.prepare('INSERT INTO instance_teams (instance_id, team_id) VALUES (?, ?)').bind(id, t).run();
  return id;
}

export async function grantPlatformRole(user: TestUser, role: 'superadmin' | 'admin' | 'support'): Promise<void> {
  await testEnv.DB.prepare('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, NULL, ?)').bind(user.id, role, Date.now()).run();
}

// ---- harness ----------------------------------------------------------------------------------

const signedIn = new Map<string, { user: SessionUser; session: SessionInfo }>();

export function harness() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    const who = signedIn.get(c.req.header('x-test-as') ?? '');
    c.set('user', who?.user ?? null);
    c.set('session', who?.session ?? null);
    c.set('requestId', 'test');
    await next();
  });
  app.route('/api/me', meApp);
  app.route('/api/platform', platformApp);
  app.route('/api/orgs', tenantApp);
  app.route('/confirm', confirmApp);
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) return c.json({ error: err.message }, status as 400);
    console.error(err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  type Opts = { as?: TestUser; mfa?: boolean; method?: SessionInfo['method']; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> };
  return async function call(method: string, path: string, opts: Opts = {}): Promise<Response> {
    const headers = new Headers(opts.headers);
    if (opts.as) {
      const key = crypto.randomUUID();
      signedIn.set(key, {
        user: opts.as,
        session: { id: `s-${opts.as.id}`, userId: opts.as.id, method: opts.method ?? 'email-otp', mfa: opts.mfa ?? false, expiresAt: Date.now() + 3_600_000, activeOrganizationId: null, ssoOrgId: null },
      });
      headers.set('x-test-as', key);
    }
    let body: BodyInit | undefined;
    if (opts.form) {
      body = new URLSearchParams(opts.form);
      headers.set('content-type', 'application/x-www-form-urlencoded');
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers.set('content-type', 'application/json');
    }
    return app.request(path, { method, headers, body }, testEnv);
  };
}

export async function gateCalls(): Promise<unknown[][]> {
  return (await (testEnv.GATE as unknown as { calls(): Promise<unknown[][]> }).calls()) as unknown[][];
}
export async function resetGate(): Promise<void> {
  await (testEnv.GATE as unknown as { reset(): Promise<void> }).reset();
}

/** The confirmation link from the newest captured email. */
export function lastConfirmLink(fakes: Fakes): { id: string; token: string } {
  const msg = [...fakes.mail].reverse().find((m) => m.text.includes('/confirm/'));
  const m = msg?.text.match(/\/confirm\/([^?\s]+)\?t=(\S+)/);
  if (!m) throw new Error('no confirmation email');
  return { id: m[1] as string, token: m[2] as string };
}

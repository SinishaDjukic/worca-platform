// Provider settings, declared not coded (docs/providers.md "Settings"): validation against the
// declaration, storage per scope, and what the provider gets on its calls.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../packages/platform/src/control/env';
import { runOp } from '../../../packages/platform/src/control/instances/ops';
import { orgSummary } from '../../../packages/platform/src/control/instances/summary';
import { getProviders, loadDeploymentSettings, providersFor } from '../../../packages/platform/src/control/providers';
import { railwayAccount, RAILWAY_SETTINGS } from '../../../packages/platform/src/control/providers/railway';
import { declarationProblems, effectiveSettings, SettingsError, storedValues, validateSettings, type SettingField } from '../../../packages/platform/src/control/providers/settings';
import { E, fakeStubFetch, gateFake, immediateSteps, installFakes as installInstanceFakes, instanceRow, recorded, seedOrg as seedTenantOrg, testApp } from './instances-helpers';
import { ensureTables, grantPlatformRole, harness, installFakes, seedUser, type TestUser } from './helpers/tenancy-fixtures';

const FIELDS: SettingField[] = [
  { key: 'zone', kind: 'select', label: 'Zone', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
  { key: 'replicas', kind: 'number', label: 'Replicas', integer: true, min: 1, max: 3 },
  { key: 'spot', kind: 'boolean', label: 'Spot' },
  { key: 'account', kind: 'text', label: 'Account', pattern: '[a-z]+', patternMessage: 'lowercase letters' },
  { key: 'token', kind: 'secret', label: 'Token', default: 'MY_TOKEN', required: true },
];

describe('settings: declaration and validation', () => {
  it('a declaration with bad keys, kinds, options or defaults is reported', () => {
    expect(declarationProblems({ deployment: FIELDS })).toEqual([]);
    expect(declarationProblems(RAILWAY_SETTINGS)).toEqual([]);
    const bad = declarationProblems({
      instance: [
        { key: 'Bad-Key', kind: 'text', label: 'x' },
        { key: 'dup', kind: 'text', label: 'x' },
        { key: 'dup', kind: 'text', label: 'x' },
        { key: 'pick', kind: 'select', label: 'x' },
        { key: 'n', kind: 'number', label: 'x', max: 2, default: 5 },
        { key: 's', kind: 'secret', label: 'x', default: 'sk-live-value' },
      ],
    });
    expect(bad).toEqual([
      'instance.Bad-Key: key must be camelCase letters and digits',
      'instance.dup: duplicate key',
      'instance.pick: a select needs options',
      'instance.n: default 5: must be at most 2',
      'instance.s: default "sk-live-value": must be the name of a Worker secret (A–Z, digits, _), never its value',
    ]);
  });

  it('values: unknown keys and wrong kinds refused, empty means unset, secrets are names only', () => {
    expect(validateSettings(FIELDS, { zone: 'b', replicas: 2, spot: true, account: ' acme ', token: 'OTHER_TOKEN' })).toEqual({ zone: 'b', replicas: 2, spot: true, account: 'acme', token: 'OTHER_TOKEN' });
    expect(validateSettings(FIELDS, { account: '', replicas: null })).toEqual({});
    expect(validateSettings(FIELDS, undefined)).toEqual({});
    const err = (() => {
      try {
        validateSettings(FIELDS, { zone: 'c', replicas: 1.5, spot: 'yes', account: 'ACME', token: 'sk_live_123', extra: 1 });
      } catch (e) {
        return e as SettingsError;
      }
    })()!;
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.problems).toEqual({
      extra: 'is not a setting of this provider',
      zone: 'must be one of the options',
      replicas: 'must be a whole number',
      spot: 'must be true or false',
      account: 'lowercase letters',
      token: 'must be the name of a Worker secret (A–Z, digits, _), never its value',
    });
    expect(() => validateSettings([{ key: 'need', kind: 'text', label: 'x', required: true }], {})).toThrow('need is required');
  });

  it('effective values: defaults, then saved ones still declared and valid; stored per provider', () => {
    expect(effectiveSettings(FIELDS, null)).toEqual({ zone: 'a', token: 'MY_TOKEN' });
    expect(effectiveSettings(FIELDS, { zone: 'b', gone: 'x', replicas: 9 } as never)).toEqual({ zone: 'b', token: 'MY_TOKEN' });
    expect(storedValues('{"provider":"railway","values":{"a":1}}', 'railway')).toEqual({ a: 1 });
    expect(storedValues('{"provider":"k8s","values":{"a":1}}', 'railway')).toBeNull();
    expect(storedValues('garbage', 'railway')).toBeNull();
  });

  it('Railway: workspace and token secret from the settings, else the RAILWAY_* vars as before', () => {
    const env = { RAILWAY_TOKEN: 'rt', RAILWAY_WORKSPACE_ID: 'ws-env', OTHER_TOKEN: 'ot' } as unknown as Env;
    expect(railwayAccount(env)).toEqual({ tokenName: 'RAILWAY_TOKEN', token: 'rt', workspaceId: 'ws-env' });
    expect(railwayAccount(env, { workspaceId: 'ws-set', tokenSecret: 'OTHER_TOKEN' })).toEqual({ tokenName: 'OTHER_TOKEN', token: 'ot', workspaceId: 'ws-set' });
    expect(railwayAccount({} as Env, { tokenSecret: 'MISSING' })).toEqual({ tokenName: 'MISSING', token: '', workspaceId: '' });
  });
});

describe('deployment settings (Operations → Provider settings)', () => {
  const call = harness();
  let root: TestUser;
  let admin: TestUser;
  beforeAll(ensureTables);
  beforeEach(async () => {
    const fakes = installFakes();
    root = await seedUser(fakes);
    await grantPlatformRole(root, 'superadmin');
    admin = await seedUser(fakes);
    await grantPlatformRole(admin, 'admin');
    await E.DB.prepare(`DELETE FROM platform_settings WHERE key = 'compute_settings'`).run();
  });
  const as = (u: TestUser) => ({ as: u, mfa: true });

  it('shows the provider\'s fields and values; superadmins save them, validated and audited by key', async () => {
    const before = (await (await call('GET', '/api/platform/provider-settings', as(admin))).json()) as Record<string, any>;
    expect(before).toMatchObject({ provider: { name: 'fake', displayName: 'Fake compute' }, saved: {}, values: {}, secretsSet: {} });
    expect(before.fields.map((f: SettingField) => f.key)).toEqual(['stubLabel']);
    expect((await call('PUT', '/api/platform/provider-settings', { ...as(admin), body: { values: { stubLabel: 'x' } } })).status).toBe(403);
    const bad = await call('PUT', '/api/platform/provider-settings', { ...as(root), body: { values: { stubLabel: 'x'.repeat(41), other: 1 } } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_provider_settings', problems: { other: 'is not a setting of this provider', stubLabel: 'at most 40 characters' } });
    const ok = await call('PUT', '/api/platform/provider-settings', { ...as(root), body: { values: { stubLabel: 'local-1' } } });
    expect(await ok.json()).toEqual({ ok: true, values: { stubLabel: 'local-1' }, secretsSet: {} });
    expect(await loadDeploymentSettings(E)).toEqual({ stubLabel: 'local-1' });
    const audit = await E.DB.prepare(`SELECT details FROM audit_platform WHERE action = 'platform.provider_settings_set' ORDER BY at DESC LIMIT 1`).first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toEqual({ provider: 'fake', keys: 'stubLabel' });
  });

  it('the provider gets them on every call (the fake sends the label to the stub)', async () => {
    await call('PUT', '/api/platform/provider-settings', { ...as(root), body: { values: { stubLabel: 'local-2' } } });
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-stub-label'));
      return Response.json({ ok: true, state: 'running' });
    }) as typeof fetch;
    const p = await providersFor(E, fetchImpl);
    await p.compute.stop({ projectId: 'x', services: { worca: { serviceId: 'w' }, broker: { serviceId: 'b' }, cloudflared: { serviceId: 'c' } } });
    expect(seen).toEqual(['local-2']);
    expect(getProviders(E, fetchImpl).compute.name).toBe('fake'); // without loading: defaults only
  });
});

describe('instance settings (new-instance form, instance page)', () => {
  const app = testApp();
  beforeEach(async () => {
    installInstanceFakes();
    await gateFake().reset();
  });

  it('the summary offers the fields; create stores checked values; the instance shows them', async () => {
    const o = await seedTenantOrg();
    expect((await orgSummary(E, o.orgId)).instances.providerFields.map((f) => f.key)).toEqual(['note']);
    const bad = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA, providerSettings: { note: 7 } } });
    expect(bad).toMatchObject({ status: 400, json: { error: 'invalid_provider_settings', problems: { note: 'must be text' } } });
    const made = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA, providerSettings: { note: 'blue' } } });
    expect(made.status).toBe(201);
    expect(made.json.providerSettings).toEqual({ note: 'blue' });
    expect(JSON.parse((await instanceRow(made.json.id))!.provider_settings)).toEqual({ provider: 'fake', values: { note: 'blue' } });
    const o2 = await seedTenantOrg(); // free tier: one instance per org
    const plain = await app.call('POST', `/api/orgs/${o2.orgId}/instances`, { user: o2.admin, body: { name: 'Plain', teamId: o2.teamA } });
    expect((await instanceRow(plain.json.id))!.provider_settings).toBeNull();
  });

  it('the create op hands them to the provider; the stored compute ref never holds them', async () => {
    const o = await seedTenantOrg();
    const made = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA, providerSettings: { note: 'green' } } });
    const stub = fakeStubFetch();
    await runOp({ env: E, providers: getProviders(E, stub.fetchImpl), steps: immediateSteps(), pollMs: 1, maxPolls: 1 }, { op: 'create', instanceId: made.json.id }).catch(() => {});
    expect(stub.calls.find((c) => c.method === 'POST' && c.path === '/__admin/instances')?.body).toMatchObject({ instanceId: made.json.id, note: 'green' });
    const ref = (await instanceRow(made.json.id))!.compute_ref;
    expect(ref && JSON.parse(ref)).not.toHaveProperty('settings');
  });

  it('tenant admins change them; members may not; audited by key', async () => {
    const o = await seedTenantOrg();
    const made = await app.call('POST', `/api/orgs/${o.orgId}/instances`, { user: o.admin, body: { name: 'Main', teamId: o.teamA } });
    const path = `/api/orgs/${o.orgId}/instances/${made.json.id}/provider-settings`;
    expect((await app.call('PUT', path, { user: o.user, body: { values: { note: 'x' } } })).status).toBe(403);
    expect((await app.call('PUT', path, { user: o.admin, body: { values: { note: 'x'.repeat(61) } } })).json).toEqual({ error: 'invalid_provider_settings', problems: { note: 'at most 60 characters' } });
    expect((await app.call('PUT', path, { user: o.admin, body: { values: { note: 'red' } } })).json).toEqual({ ok: true, providerSettings: { note: 'red' } });
    expect((await app.call('GET', `/api/orgs/${o.orgId}/instances/${made.json.id}`, { user: o.admin })).json.providerSettings).toEqual({ note: 'red' });
    expect(recorded.auditOrg.find((a) => a.action === 'instance.provider_settings_set')).toMatchObject({ orgId: o.orgId, targetId: made.json.id, details: { keys: 'note' } });
  });
});

// T4, T5: the tenant console overview, GET /api/orgs/:orgId/summary (tenant admins). Current
// state only, over existing tables: no history (no daily snapshots, no pipelines today).
import type { InstanceStatus } from '../../shared/contracts';
import type { Env } from '../env';
import { activeSsoProviders, getOrgPolicy } from '../tenancy/policy';
import { decryptDisplayName, type InstanceRow } from './api';
import { deps } from './deps';
import { featureOn } from '../features';
import { tierFor } from './routes';
import { computeSizes, sizeView } from './sizes';
import { computeInfo } from '../providers';

export const INVITATION_EXPIRING_MS = 48 * 3_600_000;

/** Better Auth date columns hold ISO text (or a number from older rows). */
function toMs(value: unknown): number | null {
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return toMs(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

async function requiredDomain(env: Env, orgId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT required_domain FROM org_login_policies WHERE org_id = ?`).bind(orgId).first<{ required_domain: string | null }>();
  if (!row?.required_domain) return null;
  const ring = deps().getKeyRing(env);
  if (!ring.isCiphertext(row.required_domain)) return row.required_domain;
  try {
    return await ring.decrypt(
      { table: 'org_login_policies', column: 'required_domain', rowId: orgId, owner: { type: 'org', id: orgId } },
      row.required_domain,
    );
  } catch {
    return null;
  }
}

async function memberLimit(env: Env, orgId: string): Promise<number | null> {
  if (!featureOn(env, 'tiers')) return null; // 2.4: no limit without tiers
  try {
    const row = await env.DB.prepare(
      `SELECT members FROM tiers WHERE id = COALESCE((SELECT tier FROM org_settings WHERE org_id = ?),
         (SELECT value FROM platform_settings WHERE key = 'default_tier'), 'free')`,
    )
      .bind(orgId)
      .first<{ members: number | null }>();
    return row?.members ?? null;
  } catch {
    return null;
  }
}

export async function orgSummary(env: Env, orgId: string, now = Date.now()) {
  const { results: rows } = await env.DB.prepare(`SELECT * FROM instances WHERE org_id = ? ORDER BY created_at`).bind(orgId).all<InstanceRow>();
  const byStatus: Partial<Record<InstanceStatus, number>> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const live = rows.filter((r) => r.status !== 'deleting');

  const upgrades = [];
  for (const r of live.filter((r) => r.available_version && r.available_version !== r.worca_version)) {
    upgrades.push({ id: r.id, name: await decryptDisplayName(env, r), version: r.worca_version, availableVersion: r.available_version });
  }
  const degraded = [];
  for (const r of live.filter((r) => r.status === 'running' && r.health === 'degraded')) {
    degraded.push({ id: r.id, name: await decryptDisplayName(env, r), healthSince: r.health_since, lastHeartbeatAt: r.last_heartbeat_at });
  }

  const [members, invitations, overrides] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM member WHERE organizationId = ?`).bind(orgId),
    env.DB.prepare(`SELECT expiresAt FROM invitation WHERE organizationId = ? AND status = 'pending'`).bind(orgId),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM instance_login_policies p JOIN instances i ON i.id = p.instance_id
        WHERE i.org_id = ? AND i.status <> 'deleting' AND p.required_methods <> '[]'`,
    ).bind(orgId),
  ]);
  let open = 0;
  let expiringSoon = 0;
  for (const inv of (invitations?.results ?? []) as { expiresAt: unknown }[]) {
    const at = toMs(inv.expiresAt);
    if (at === null || at <= now) continue;
    open++;
    if (at - now <= INVITATION_EXPIRING_MS) expiringSoon++;
  }

  const tier = await tierFor(env, orgId);
  const policy = await getOrgPolicy(env, orgId);
  return {
    instances: {
      byStatus,
      total: live.length,
      limit: tier.instancesPerOrg,
      // D78: the compute sizes the tier allows (new-instance form, size picker) and the default.
      sizes: tier.sizes.map((id) => sizeView(computeSizes(env).byId(id)!)),
      defaultSize: tier.defaultSize,
      // The compute provider's instance settings fields for the new-instance form (docs/providers.md).
      providerFields: computeInfo(env).settings?.instance ?? [],
      upgradesAvailable: upgrades,
      degraded,
    },
    members: {
      count: ((members?.results?.[0] as { n: number } | undefined)?.n ?? 0),
      limit: await memberLimit(env, orgId),
    },
    invitations: { open, expiringWithin48h: expiringSoon },
    signIn: {
      allowedMethods: policy.allowedMethods, // empty: every method
      requiredDomain: await requiredDomain(env, orgId),
      instanceOverrides: ((overrides?.results?.[0] as { n: number } | undefined)?.n ?? 0),
      ssoProviders: (await activeSsoProviders(env, orgId)).length,
    },
  };
}

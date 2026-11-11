// Cloudflare edge provider: one remotely managed tunnel per instance (D5) and two proxied CNAMEs
// pointing at it (D51). Cloudflare v4 REST API; endpoints checked against the API reference on
// 2026-10-06.
import type { Env } from '../env';
import { fetchWithRetry, type Fetch, type ProviderOptions } from './http';
import { resourcePrefix } from './prefix';
import type { EdgeProvider, InstanceSpec, TunnelOrigins, TunnelStatus } from './types';

export const CF_API = 'https://api.cloudflare.com/client/v4';

export const tunnelName = (prefix: string, instanceId: string) => `${prefix}${instanceId}`;
/** Comment on every DNS record we create (the resource prefix, `worca-run-` → `worca-run `); records without it are never changed. */
export const dnsCommentPrefix = (prefix: string) => `${prefix.replace(/-$/, '')} `;

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

/**
 * Ingress: each host to its service over the compute provider's private network (TunnelOrigins).
 * The key host goes to the broker's key page port only; its private API port (8080) is never routed.
 */
export function tunnelIngress(spec: Pick<InstanceSpec, 'host' | 'keyHost'>, origins: TunnelOrigins) {
  return [
    { hostname: spec.host, service: origins.worca },
    { hostname: spec.keyHost, service: origins.keyPage },
    { service: 'http_status:404' }, // cloudflared requires a final catch-all rule
  ];
}

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
}

const TUNNEL_STATUSES = new Set<TunnelStatus>(['healthy', 'degraded', 'down', 'inactive']);

export function createCloudflareEdge(env: Env, fetchImpl: Fetch = fetch, opts: ProviderOptions & { resourcePrefix?: string } = {}): EdgeProvider {
  const prefix = opts.resourcePrefix ?? resourcePrefix(env);
  const DNS_COMMENT_PREFIX = dnsCommentPrefix(prefix);
  const doFetch: Fetch = (url, init) => fetchImpl(url, init);

  async function call<T>(method: string, path: string, body?: unknown, okIfMissing = false): Promise<T | undefined> {
    if (!env.CF_API_TOKEN) throw new Error('cloudflare: CF_API_TOKEN is not set');
    const res = await fetchWithRetry(
      doFetch,
      `${CF_API}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      opts,
    );
    // Deletes are retried by the Workflow; something already gone is done.
    if (okIfMissing && res.status === 404) return undefined;
    const json = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!json?.success) {
      const messages = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
      throw new Error(`cloudflare ${method} ${path}: ${messages || `HTTP ${res.status}`}`);
    }
    return json.result;
  }

  const account = () => {
    if (!env.CF_ACCOUNT_ID) throw new Error('cloudflare: CF_ACCOUNT_ID is not set');
    return `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`;
  };
  const zone = () => {
    if (!env.CF_ZONE_ID) throw new Error('cloudflare: CF_ZONE_ID is not set');
    return `/zones/${env.CF_ZONE_ID}/dns_records`;
  };

  /** The id of our live tunnel with exactly this name, if one exists. */
  async function findTunnel(name: string): Promise<string | undefined> {
    const q = new URLSearchParams({ name, is_deleted: 'false' });
    const list = (await call<{ id: string; name: string }[]>('GET', `${account()}?${q}`)) ?? [];
    return list.find((t) => t.name === name)?.id;
  }

  return {
    name: 'cloudflare',

    // Every create below is safe to run again (a Workflow step retried after a call that succeeded
    // at Cloudflare but whose answer was lost): it first looks for what an earlier attempt made.
    async createTunnel(spec, origins) {
      const name = tunnelName(prefix, spec.instanceId);
      let tunnelId = await findTunnel(name);
      if (!tunnelId) {
        try {
          const tunnel = await call<{ id: string }>('POST', account(), {
            name,
            config_src: 'cloudflare', // remotely managed: ingress lives at Cloudflare, not in cloudflared
          });
          tunnelId = tunnel!.id;
        } catch (err) {
          // A name conflict means an earlier attempt's tunnel appeared meanwhile: use it.
          tunnelId = await findTunnel(name);
          if (!tunnelId) throw err;
        }
      }
      // PUT replaces the whole configuration and GET token only reads: both repeat safely.
      await call('PUT', `${account()}/${tunnelId}/configurations`, { config: { ingress: tunnelIngress(spec, origins) } });
      const tunnelToken = await call<string>('GET', `${account()}/${tunnelId}/token`);
      return { tunnelId, tunnelToken: tunnelToken! };
    },

    async addDns(spec, tunnelId) {
      const ids: string[] = [];
      for (const name of [spec.host, spec.keyHost]) {
        const want = {
          type: 'CNAME',
          name,
          content: `${tunnelId}.cfargotunnel.com`,
          proxied: true, // the gate Worker's route only sees proxied traffic
          ttl: 1,
          comment: `${DNS_COMMENT_PREFIX}${spec.instanceId}`,
        };
        // Upsert: a record for this name from an earlier attempt is reused (and pointed at this
        // tunnel); one we didn't make (no worca-run comment) is never touched.
        const existing = ((await call<DnsRecord[]>('GET', `${zone()}?${new URLSearchParams({ name, per_page: '100' })}`)) ?? []).filter(
          (r) => r.name === name,
        );
        const foreign = existing.find((r) => r.type !== 'CNAME' || !r.comment?.startsWith(DNS_COMMENT_PREFIX));
        if (foreign) throw new Error(`cloudflare: ${name} already has a ${foreign.type} record (${foreign.id}) that is not a worca-run one`);
        const mine = existing[0];
        if (!mine) {
          const record = await call<{ id: string }>('POST', zone(), want);
          ids.push(record!.id);
        } else {
          if (mine.content !== want.content || mine.proxied !== true || mine.comment !== want.comment) {
            await call('PUT', `${zone()}/${mine.id}`, want);
          }
          ids.push(mine.id);
        }
      }
      return ids;
    },

    async deleteDns(recordIds) {
      for (const id of recordIds) await call('DELETE', `${zone()}/${id}`, undefined, true);
    },

    async deleteTunnel(tunnelId) {
      // A tunnel with active connections can't be deleted; cloudflared may still be connected or
      // its connections not yet expired after the Railway project is gone.
      await call('DELETE', `${account()}/${tunnelId}/connections`, undefined, true);
      await call('DELETE', `${account()}/${tunnelId}`, undefined, true);
    },

    async rotateTunnelSecret(tunnelId) {
      // Only our own tunnels: the account also holds the team's (e.g. worca-01's).
      const tunnel = await call<{ id: string; name: string }>('GET', `${account()}/${tunnelId}`);
      if (!tunnel?.name.startsWith(prefix)) throw new Error(`cloudflare: refusing to touch tunnel ${tunnelId} (${tunnel?.name}): not one of ours (${prefix}*)`);
      // 32 random bytes, base64: the form Cloudflare takes for tunnel_secret. The new secret is
      // never returned or logged, only the token built from it.
      const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await call('PATCH', `${account()}/${tunnelId}`, { tunnel_secret: secret });
      // A new secret leaves connections already open alone (seen on 2026-10-23), including any a
      // leaked token opened: drop them all. Whatever still holds the old token can't reconnect.
      await call('DELETE', `${account()}/${tunnelId}/connections`, undefined, true);
      const token = await call<string>('GET', `${account()}/${tunnelId}/token`);
      if (!token) throw new Error(`cloudflare: no token for tunnel ${tunnelId} after rotating its secret`);
      return token;
    },

    async findEdge(instanceId, hosts) {
      const tunnelId = (await findTunnel(tunnelName(prefix, instanceId))) ?? '';
      const comment = `${DNS_COMMENT_PREFIX}${instanceId}`;
      const dnsRecordIds: string[] = [];
      for (const name of hosts) {
        const records = (await call<DnsRecord[]>('GET', `${zone()}?${new URLSearchParams({ name, per_page: '100' })}`)) ?? [];
        // Only records this instance's create made, by their comment.
        for (const r of records) if (r.name === name && r.comment === comment) dnsRecordIds.push(r.id);
      }
      return tunnelId || dnsRecordIds.length ? { tunnelId, dnsRecordIds } : null;
    },

    async connectorVersions(tunnelId) {
      // The tunnel's own record lists its live connections, each with the cloudflared version that
      // opened it. Only our tunnels, as in rotateTunnelSecret.
      const tunnel = await call<{ name: string; connections?: { client_version?: string; is_pending_reconnect?: boolean }[] }>('GET', `${account()}/${tunnelId}`);
      if (!tunnel?.name.startsWith(prefix)) throw new Error(`cloudflare: refusing to read tunnel ${tunnelId} (${tunnel?.name}): not one of ours (${prefix}*)`);
      return (tunnel.connections ?? []).filter((c) => !c.is_pending_reconnect).map((c) => c.client_version ?? '');
    },

    async tunnelStatuses(_tunnelIds) {
      // One list call (paged by 100) instead of GET cfd_tunnel/{id} per instance; the list
      // carries the same `status`. Only our tunnels: prefix filter, checked again here.
      if (!env.CF_API_TOKEN) throw new Error('cloudflare: CF_API_TOKEN is not set');
      const out: Record<string, TunnelStatus> = {};
      for (let page = 1; page <= 50; page++) {
        const q = new URLSearchParams({ is_deleted: 'false', include_prefix: prefix, per_page: '100', page: String(page) });
        const res = await fetchWithRetry(
          doFetch,
          `${CF_API}${account()}?${q}`,
          { method: 'GET', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } },
          opts,
        );
        const json = (await res.json().catch(() => null)) as CfEnvelope<{ id: string; name: string; status: string }[]> | null;
        if (!json?.success) {
          const messages = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
          throw new Error(`cloudflare GET ${account()}: ${messages || `HTTP ${res.status}`}`);
        }
        for (const t of json.result) {
          if (t.name.startsWith(prefix) && TUNNEL_STATUSES.has(t.status as TunnelStatus)) out[t.id] = t.status as TunnelStatus;
        }
        if (json.result.length < 100 || page >= (json.result_info?.total_pages ?? page)) break;
      }
      return out;
    },
  };
}

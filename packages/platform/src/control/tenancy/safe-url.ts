// URLs tenants hand us that the control plane later fetches itself (SSO issuers, OIDC endpoints,
// SAML entry points). Refuses what could reach internal or our own services (SSRF).
import { z } from 'zod';
import type { Env } from '../env';

export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6, bracketed or not
  if (/^[0-9.]+$/.test(host)) return true; // dotted IPv4, including short forms like 127.1
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) return true; // hex or decimal IPv4
  return false;
}

const BLOCKED_SUFFIXES = ['localhost', 'internal', 'local', 'localdomain', 'home.arpa'];

/** Host checks that need no env: no IPs, no local or internal names. */
export function isPublicHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host) || !host.includes('.')) return false;
  return !BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Our own domains (instance domain, control plane) are never a tenant's IdP. */
export function isForeignHost(env: Pick<Env, 'INSTANCE_DOMAIN' | 'APP_ORIGIN'>, hostname: string): boolean {
  const host = normalizeHost(hostname);
  const ours = [normalizeHost(env.INSTANCE_DOMAIN), normalizeHost(new URL(env.APP_ORIGIN).hostname)];
  return !ours.some((d) => host === d || host.endsWith(`.${d}`));
}

export function isSafeUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && isPublicHost(url.hostname);
}

export const safeUrl = z.string().max(2000).refine(isSafeUrl, 'url must be https on a public host');

/** Registrable-ish host: the last two labels (good enough to keep endpoints with the issuer). */
export function siteOf(hostname: string): string {
  return normalizeHost(hostname).split('.').slice(-2).join('.');
}

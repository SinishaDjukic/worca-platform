// OWNER: agent:identity. ControlRpc methods the gate calls over its service binding (D45).
import type { CodeExchange, TokenRenewal } from '../../shared/contracts';
import type { Env } from '../env';
import { issueForSession } from './access';
import { consumeGateCode } from './codes';

/** One-time code -> identity token. The code is spent even when a later check fails. */
export async function exchangeCode(env: Env, code: string, host: string): Promise<CodeExchange | null> {
  const grant = await consumeGateCode(env, code, host);
  if (!grant) return null;
  const issued = await issueForSession(env, grant);
  if (!issued) return null;
  return {
    token: issued.token,
    tokenExp: issued.tokenExp,
    userId: grant.userId,
    cpSessionId: grant.sessionId,
    instanceId: issued.instanceId,
  };
}

/** A fresh token while the session, the team access and the login policy all still hold. */
export async function renewToken(env: Env, input: { cpSessionId: string; userId: string; host: string }): Promise<TokenRenewal | null> {
  const issued = await issueForSession(env, { userId: input.userId, sessionId: input.cpSessionId, host: input.host });
  return issued ? { token: issued.token, tokenExp: issued.tokenExp } : null;
}

import type { GateRpcApi } from '../shared/contracts';
import type { Env } from './env';

/** The gate's RPC entrypoint, over the service binding (D43). */
export function gate(env: Env): GateRpcApi {
  return env.GATE as unknown as GateRpcApi;
}

/**
 * Drops a user's gate sessions on every instance of every org they belong to (D46): sign-out,
 * session revocation, account disabling. Instances are few per org, so this stays small.
 */
export async function dropGateSessionsForUser(
  env: Env,
  userId: string,
  filter: { userId: string } | { cpSessionId: string } = { userId },
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT i.id FROM instances i JOIN member m ON m.organizationId = i.org_id
     WHERE m.userId = ? AND i.status NOT IN ('deleting')`,
  )
    .bind(userId)
    .all<{ id: string }>();
  await Promise.all(
    results.map((r) =>
      gate(env)
        .dropSessions(r.id, filter)
        .catch((e: unknown) => console.error(JSON.stringify({ at: 'drop_gate_sessions', instanceId: r.id, error: String(e) }))),
    ),
  );
}

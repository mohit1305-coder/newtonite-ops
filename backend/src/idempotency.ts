import type { PoolClient } from "pg";
import { HttpError } from "./errors";

export type Result<T> = { status: number; body: T; replayed?: boolean };

/**
 * Runs inside the caller's transaction. The first request with a key inserts a
 * row and does the work. A concurrent duplicate blocks on the primary key until
 * the first commits, then reads the stored response instead of repeating the
 * work. A failed request rolls back, so the key is free to be retried.
 */
export async function withIdempotency<T>(
  c: PoolClient,
  userId: string,
  key: string | undefined,
  scope: string,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (!key) return fn();
  const ins = await c.query(
    `INSERT INTO idempotency_keys (user_id, key, scope) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING key`,
    [userId, key, scope],
  );
  if (ins.rowCount === 0) {
    const r = await c.query(
      "SELECT scope, status_code, response FROM idempotency_keys WHERE user_id = $1 AND key = $2",
      [userId, key],
    );
    const row = r.rows[0];
    if (row.scope !== scope)
      throw new HttpError(422, "IDEMPOTENCY_KEY_REUSED", "This key was used for a different request");
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const result = await fn();
  await c.query(
    "UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE user_id = $1 AND key = $2",
    [userId, key, result.status, JSON.stringify(result.body)],
  );
  return result;
}

import { Pool, PoolClient } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

/** Run `fn` inside a transaction. Any thrown error rolls everything back. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

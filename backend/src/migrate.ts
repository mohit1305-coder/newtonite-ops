import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const done = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (done.rowCount) continue;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(readFileSync(join(dir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await c.query("COMMIT");
      console.log("applied", file);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

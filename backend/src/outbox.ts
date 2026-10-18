import type { PoolClient } from "pg";
import { tx } from "./db";

const MAX_ATTEMPTS = 5;

async function notify(c: PoolClient, outboxId: number, userId: string | null | undefined, itemId: string, message: string, actorId?: string) {
  if (!userId || userId === actorId) return; // never notify people about their own actions
  // The unique dedupe_key makes this safe to run more than once for the same outbox row.
  await c.query(
    `INSERT INTO notifications (user_id, item_id, message, dedupe_key)
     VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, itemId, message, `${outboxId}:${userId}`],
  );
}

export async function handle(c: PoolClient, row: { id: number; type: string; payload: any }) {
  const p = row.payload;
  const title = p.title ?? "a work item";
  switch (row.type) {
    case "item.assigned":
      await notify(c, row.id, p.assigneeId, p.itemId, `You were assigned: ${title}`, p.actorId);
      break;
    case "item.status_changed":
      for (const uid of new Set([p.assigneeId, p.reporterId]))
        await notify(c, row.id, uid, p.itemId, `${title} moved to ${p.to}`, p.actorId);
      break;
    case "item.commented":
      for (const uid of new Set([p.assigneeId, p.reporterId]))
        await notify(c, row.id, uid, p.itemId, `New comment on ${title}`, p.actorId);
      break;
    case "item.created":
      if (p.priority === "HIGH" || p.priority === "URGENT") {
        const leads = await c.query("SELECT user_id FROM memberships WHERE team_id = $1 AND role = 'lead'", [p.teamId]);
        for (const l of leads.rows)
          await notify(c, row.id, l.user_id, p.itemId, `${p.priority} item created: ${title}`, p.actorId);
      }
      break;
    default:
      throw new Error(`Unknown outbox type ${row.type}`);
  }
}

/**
 * Claims a batch with FOR UPDATE SKIP LOCKED so several workers can run side by
 * side without handling the same row. Each handler runs in a savepoint: if it
 * throws, its partial writes are undone and the row is rescheduled with
 * exponential backoff. After MAX_ATTEMPTS it is parked (failed_at) for a human.
 * Delivery is at-least-once; handlers are idempotent.
 */
export async function processBatch(limit = 10): Promise<number> {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, type, payload, attempts FROM outbox
       WHERE processed_at IS NULL AND failed_at IS NULL AND run_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const row of rows) {
      await c.query("SAVEPOINT handler");
      try {
        await handle(c, row);
        await c.query("RELEASE SAVEPOINT handler");
        await c.query("UPDATE outbox SET processed_at = now(), attempts = attempts + 1 WHERE id = $1", [row.id]);
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT handler");
        const attempts = row.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        const delay = Math.min(2 ** attempts * 5, 300);
        await c.query(
          `UPDATE outbox SET attempts = $2, last_error = $3,
                  run_at = now() + make_interval(secs => $4::int),
                  failed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END
           WHERE id = $1`,
          [row.id, attempts, String(e), delay, dead],
        );
      }
    }
    return rows.length;
  });
}

export function startWorker(intervalMs = 1000) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const n = await processBatch();
        if (n === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        console.error("worker error", e);
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

import type { Pool, PoolClient } from "pg";
import { pool } from "./db";
import { HttpError, notFound } from "./errors";
import { can, getRole, requireCan, requireTeamRole } from "./authz";
import { allowedTransitions, checkTransition, type Priority, type Role, type Status } from "./workflow";

type Db = Pick<Pool | PoolClient, "query">;
const TERMINAL: Status[] = ["DONE", "CANCELLED"];

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const ITEM_COLUMNS = `
  w.id, w.team_id, t.name AS team_name, w.title, w.description, w.status, w.priority,
  w.reporter_id, r.name AS reporter_name, w.assignee_id, a.name AS assignee_name,
  w.due_at, w.version, w.created_at, w.updated_at`;
const ITEM_FROM = `
  FROM work_items w
  JOIN teams t ON t.id = w.team_id
  JOIN users r ON r.id = w.reporter_id
  LEFT JOIN users a ON a.id = w.assignee_id`;

function toDto(row: any, viewer?: { role: Role; userId: string }) {
  const dto: any = {
    id: row.id,
    teamId: row.team_id,
    teamName: row.team_name,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    dueAt: row.due_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (viewer) {
    const isAssignee = row.assignee_id === viewer.userId;
    const isReporter = row.reporter_id === viewer.userId;
    const active = !TERMINAL.includes(row.status);
    dto.permissions = {
      canEdit: active && can(viewer.role, "edit", { isAssignee, isReporter }),
      canAssign: active && can(viewer.role, "assign"),
      canClaim: active && !row.assignee_id && can(viewer.role, "claim"),
      canComment: can(viewer.role, "comment"),
      transitions: allowedTransitions({
        from: row.status,
        role: viewer.role,
        isAssignee,
        hasAssignee: !!row.assignee_id,
      }),
    };
  }
  return dto;
}

/** Read one item as the given user. 404 if they are not in the item's team. */
export async function getItem(db: Db, userId: string, itemId: string) {
  const r = await db.query(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE w.id = $1`, [itemId]);
  if (!r.rows[0]) throw notFound("Work item");
  const role = await getRole(db, userId, r.rows[0].team_id);
  if (!role) throw notFound("Work item");
  return toDto(r.rows[0], { role, userId });
}

type Cursor = { t: string; id: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString());
    if (typeof c.t === "string" && typeof c.id === "string") return c;
  } catch {}
  throw new HttpError(400, "INVALID_CURSOR", "Invalid pagination cursor");
}

export type ListFilters = {
  teamId?: string;
  status?: string[];
  priority?: string[];
  assignee?: string; // "me" | "none" | user id
  q?: string;
  overdue?: boolean;
  cursor?: string;
  limit: number;
};

/**
 * Keyset pagination on (updated_at, id). Cost per page does not grow with
 * depth, and rows being edited while the user pages cannot cause skips or
 * repeats the way OFFSET would. The cursor timestamp is taken as text so
 * Postgres' microsecond precision survives the round trip through JS.
 */
export async function listItems(userId: string, f: ListFilters) {
  const params: any[] = [userId];
  const where = ["w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1)"];
  const add = (sql: string, value: any) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.teamId) add("w.team_id = ?", f.teamId);
  if (f.status?.length) add("w.status = ANY(?)", f.status);
  if (f.priority?.length) add("w.priority = ANY(?)", f.priority);
  if (f.assignee === "me") where.push("w.assignee_id = $1");
  else if (f.assignee === "none") where.push("w.assignee_id IS NULL");
  else if (f.assignee) add("w.assignee_id = ?", f.assignee);
  if (f.q) add("w.search @@ websearch_to_tsquery('english', ?)", f.q);
  if (f.overdue) where.push("w.due_at < now() AND w.status NOT IN ('DONE','CANCELLED')");
  if (f.cursor) {
    const cur = decodeCursor(f.cursor);
    params.push(cur.t, cur.id);
    where.push(`(w.updated_at, w.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(f.limit + 1);

  const r = await pool.query(
    `SELECT ${ITEM_COLUMNS},
            to_char(w.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     ${ITEM_FROM}
     WHERE ${where.join(" AND ")}
     ORDER BY w.updated_at DESC, w.id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > f.limit;
  const rows = hasMore ? r.rows.slice(0, f.limit) : r.rows;
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => toDto(row)),
    nextCursor: hasMore && last ? encodeCursor({ t: last.cursor_ts, id: last.id }) : null,
  };
}

/** "What needs attention" sections. Each is a bounded, indexed query. */
export async function dashboard(userId: string) {
  const visible = "w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1)";
  const active = "w.status NOT IN ('DONE','CANCELLED')";
  const rank = "CASE w.priority WHEN 'URGENT' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END";
  const sections: Record<string, [string, string]> = {
    mine: [`${visible} AND w.assignee_id = $1 AND ${active}`, `${rank} DESC, w.due_at NULLS LAST, w.updated_at DESC`],
    unassignedUrgent: [
      `${visible} AND w.assignee_id IS NULL AND w.status = 'OPEN' AND w.priority IN ('HIGH','URGENT')`,
      `${rank} DESC, w.created_at`,
    ],
    overdue: [`${visible} AND w.due_at < now() AND ${active}`, "w.due_at"],
    awaitingApproval: [
      `w.status = 'IN_REVIEW' AND w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1 AND role = 'lead')`,
      "w.updated_at",
    ],
    stale: [
      `${visible} AND w.status IN ('IN_PROGRESS','BLOCKED') AND w.updated_at < now() - interval '3 days'`,
      "w.updated_at",
    ],
  };
  const entries = await Promise.all(
    Object.entries(sections).map(async ([name, [cond, order]]) => {
      const r = await pool.query(
        `SELECT ${ITEM_COLUMNS}, count(*) OVER () AS total ${ITEM_FROM}
         WHERE ${cond} ORDER BY ${order} LIMIT 8`,
        [userId],
      );
      return [name, { total: Number(r.rows[0]?.total ?? 0), items: r.rows.map((row) => toDto(row)) }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function listEvents(userId: string, itemId: string, before: string | undefined, limit: number) {
  const item = await pool.query("SELECT team_id FROM work_items WHERE id = $1", [itemId]);
  if (!item.rows[0]) throw notFound("Work item");
  await requireTeamRole(pool, userId, item.rows[0].team_id).catch(() => {
    throw notFound("Work item");
  });
  const params: any[] = [itemId, limit + 1];
  let cond = "";
  if (before) {
    params.push(before);
    cond = "AND e.id < $3::bigint";
  }
  const r = await pool.query(
    `SELECT e.id, e.type, e.data, e.created_at, e.actor_id, u.name AS actor_name
     FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.item_id = $1 ${cond}
     ORDER BY e.id DESC LIMIT $2`,
    params,
  );
  const hasMore = r.rows.length > limit;
  const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
  return {
    events: rows.map((e) => ({
      id: String(e.id),
      type: e.type,
      data: e.data,
      createdAt: e.created_at,
      actorId: e.actor_id,
      actorName: e.actor_name,
    })),
    nextBefore: hasMore ? String(rows[rows.length - 1].id) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Writing (every function expects to run inside a transaction)        */
/* ------------------------------------------------------------------ */

/** Lock the item row and load the caller's role in its team. */
async function lockItem(c: PoolClient, userId: string, itemId: string) {
  const r = await c.query(
    `SELECT w.id, w.team_id, w.title, w.description, w.status, w.priority, w.reporter_id,
            w.assignee_id, w.due_at, w.version, m.role
     FROM work_items w
     LEFT JOIN memberships m ON m.team_id = w.team_id AND m.user_id = $2
     WHERE w.id = $1
     FOR UPDATE OF w`,
    [itemId, userId],
  );
  const row = r.rows[0];
  if (!row || !row.role) throw notFound("Work item");
  return row as any;
}

/** Stale-write protection: the client must have seen the current version. */
async function assertVersion(c: PoolClient, userId: string, row: any, expected: number) {
  if (row.version !== expected) {
    const current = await getItem(c, userId, row.id);
    throw new HttpError(409, "VERSION_CONFLICT", "This item was changed by someone else", { current });
  }
}

/** History and the outbox message are written in the same transaction as the change. */
async function record(
  c: PoolClient,
  item: { id: string; team_id: string },
  actorId: string,
  type: string,
  data: object,
  notify?: { type: string; payload: object },
) {
  await c.query(
    "INSERT INTO activity_events (item_id, team_id, actor_id, type, data) VALUES ($1,$2,$3,$4,$5)",
    [item.id, item.team_id, actorId, type, JSON.stringify(data)],
  );
  if (notify)
    await c.query("INSERT INTO outbox (type, payload) VALUES ($1, $2)", [
      notify.type,
      JSON.stringify({ itemId: item.id, title: (data as any).title, actorId, ...notify.payload }),
    ]);
}

export async function createItem(
  c: PoolClient,
  userId: string,
  input: { teamId: string; title: string; description: string; priority: Priority; dueAt: string | null },
) {
  const role = await requireTeamRole(c, userId, input.teamId);
  requireCan(role, "create");
  const r = await c.query(
    `INSERT INTO work_items (team_id, title, description, priority, reporter_id, due_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, team_id`,
    [input.teamId, input.title, input.description, input.priority, userId, input.dueAt],
  );
  const item = r.rows[0];
  await record(c, item, userId, "created", { title: input.title, priority: input.priority }, {
    type: "item.created",
    payload: { teamId: input.teamId, priority: input.priority },
  });
  return getItem(c, userId, item.id);
}

export async function updateItem(
  c: PoolClient,
  userId: string,
  itemId: string,
  input: { version: number; title?: string; description?: string; priority?: Priority; dueAt?: string | null },
) {
  const row = await lockItem(c, userId, itemId);
  requireCan(row.role, "edit", { isAssignee: row.assignee_id === userId, isReporter: row.reporter_id === userId });
  if (TERMINAL.includes(row.status))
    throw new HttpError(422, "ITEM_CLOSED", "Reopen the item before editing it");
  await assertVersion(c, userId, row, input.version);

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const sets: string[] = [];
  const params: any[] = [itemId];
  const change = (field: string, col: string, from: unknown, to: unknown) => {
    if (from === to) return;
    changes[field] = { from, to };
    params.push(to);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.title !== undefined) change("title", "title", row.title, input.title);
  if (input.description !== undefined) change("description", "description", row.description, input.description);
  if (input.priority !== undefined) change("priority", "priority", row.priority, input.priority);
  if (input.dueAt !== undefined) {
    const cur = row.due_at ? new Date(row.due_at).toISOString() : null;
    const next = input.dueAt ? new Date(input.dueAt).toISOString() : null;
    change("dueAt", "due_at", cur, next);
  }
  if (sets.length === 0) return getItem(c, userId, itemId); // nothing changed: no new version

  await c.query(
    `UPDATE work_items SET ${sets.join(", ")}, version = version + 1, updated_at = now() WHERE id = $1`,
    params,
  );
  await record(c, row, userId, "updated", { title: row.title, changes });
  return getItem(c, userId, itemId);
}

/**
 * Take responsibility. The row lock serialises concurrent claims: the first
 * commits, every later one sees an assignee and gets 409. Claiming something
 * that is already yours is a harmless no-op, so a double-click or a retry is safe.
 */
export async function claimItem(c: PoolClient, userId: string, itemId: string) {
  const row = await lockItem(c, userId, itemId);
  requireCan(row.role, "claim");
  if (row.assignee_id === userId) return getItem(c, userId, itemId);
  if (row.assignee_id) {
    const current = await getItem(c, userId, itemId);
    throw new HttpError(409, "ALREADY_ASSIGNED", `Already taken by ${current.assigneeName}`, { current });
  }
  if (TERMINAL.includes(row.status)) throw new HttpError(422, "ITEM_CLOSED", "This item is closed");

  const newStatus: Status = row.status === "OPEN" ? "IN_PROGRESS" : row.status;
  await c.query(
    "UPDATE work_items SET assignee_id = $2, status = $3, version = version + 1, updated_at = now() WHERE id = $1",
    [itemId, userId, newStatus],
  );
  await record(c, row, userId, "assigned", { title: row.title, from: null, to: userId, via: "claim" }, {
    type: "item.assigned",
    payload: { assigneeId: userId },
  });
  if (newStatus !== row.status)
    await record(c, row, userId, "status_changed", { title: row.title, from: row.status, to: newStatus, auto: true });
  return getItem(c, userId, itemId);
}

export async function assignItem(
  c: PoolClient,
  userId: string,
  itemId: string,
  input: { assigneeId: string | null; version: number },
) {
  const row = await lockItem(c, userId, itemId);
  requireCan(row.role, "assign");
  if (TERMINAL.includes(row.status)) throw new HttpError(422, "ITEM_CLOSED", "This item is closed");
  await assertVersion(c, userId, row, input.version);
  if (input.assigneeId === row.assignee_id) return getItem(c, userId, itemId);

  let newStatus: Status = row.status;
  if (input.assigneeId) {
    const targetRole = await getRole(c, input.assigneeId, row.team_id);
    if (!targetRole || targetRole === "viewer")
      throw new HttpError(422, "INVALID_ASSIGNEE", "Assignee must be a member or lead of this team");
    if (row.status === "OPEN") newStatus = "IN_PROGRESS";
  } else {
    if (row.status !== "OPEN" && row.status !== "IN_PROGRESS")
      throw new HttpError(422, "INVALID_UNASSIGN", "Cannot remove the owner while the item is blocked or in review");
    if (row.status === "IN_PROGRESS") newStatus = "OPEN";
  }
  await c.query(
    "UPDATE work_items SET assignee_id = $2, status = $3, version = version + 1, updated_at = now() WHERE id = $1",
    [itemId, input.assigneeId, newStatus],
  );
  await record(c, row, userId, "assigned", { title: row.title, from: row.assignee_id, to: input.assigneeId, via: "lead" }, {
    type: "item.assigned",
    payload: { assigneeId: input.assigneeId },
  });
  if (newStatus !== row.status)
    await record(c, row, userId, "status_changed", { title: row.title, from: row.status, to: newStatus, auto: true });
  return getItem(c, userId, itemId);
}

export async function transitionItem(
  c: PoolClient,
  userId: string,
  itemId: string,
  input: { to: Status; version: number; note?: string },
) {
  const row = await lockItem(c, userId, itemId);
  await assertVersion(c, userId, row, input.version);
  const problem = checkTransition({
    from: row.status,
    to: input.to,
    role: row.role,
    isAssignee: row.assignee_id === userId,
    hasAssignee: !!row.assignee_id,
  });
  if (problem) {
    throw problem.kind === "forbidden"
      ? new HttpError(403, "FORBIDDEN", problem.message)
      : new HttpError(422, "INVALID_TRANSITION", problem.message);
  }
  // A reopened item goes back to the pool of unowned work.
  const clearOwner = input.to === "OPEN" && row.assignee_id;
  await c.query(
    `UPDATE work_items SET status = $2, assignee_id = CASE WHEN $3::boolean THEN NULL ELSE assignee_id END,
            version = version + 1, updated_at = now() WHERE id = $1`,
    [itemId, input.to, !!clearOwner],
  );
  await record(
    c,
    row,
    userId,
    "status_changed",
    { title: row.title, from: row.status, to: input.to, note: input.note ?? null },
    { type: "item.status_changed", payload: { assigneeId: row.assignee_id, reporterId: row.reporter_id, from: row.status, to: input.to } },
  );
  if (clearOwner)
    await record(c, row, userId, "assigned", { title: row.title, from: row.assignee_id, to: null, via: "reopen" });
  return getItem(c, userId, itemId);
}

/** Comments do not bump `version`, so chatting never causes edit conflicts. */
export async function addComment(c: PoolClient, userId: string, itemId: string, body: string) {
  const r = await c.query(
    `SELECT w.id, w.team_id, w.title, w.assignee_id, w.reporter_id, m.role
     FROM work_items w LEFT JOIN memberships m ON m.team_id = w.team_id AND m.user_id = $2
     WHERE w.id = $1`,
    [itemId, userId],
  );
  const row = r.rows[0];
  if (!row || !row.role) throw notFound("Work item");
  requireCan(row.role, "comment");
  await c.query("UPDATE work_items SET updated_at = now() WHERE id = $1", [itemId]);
  await record(c, row, userId, "comment", { title: row.title, body }, {
    type: "item.commented",
    payload: { assigneeId: row.assignee_id, reporterId: row.reporter_id },
  });
  return { ok: true };
}

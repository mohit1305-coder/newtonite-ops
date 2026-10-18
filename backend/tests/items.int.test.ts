import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../src/db";
import { migrate } from "../src/migrate";
import { buildApp } from "../src/app";
import { signToken, hashPassword } from "../src/auth";
import { processBatch } from "../src/outbox";

// Requires Postgres: `docker compose up -d db` (uses the ops_test database).

let app: FastifyInstance;
let teamId: string;
let otherTeamId: string;
const ids: Record<string, string> = {};

async function mkUser(name: string, role?: "viewer" | "member" | "lead", team = teamId) {
  const r = await pool.query(
    "INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id",
    [`${name}@t.dev`, name, hashPassword("x")],
  );
  ids[name] = r.rows[0].id;
  if (role) await pool.query("INSERT INTO memberships (user_id, team_id, role) VALUES ($1,$2,$3)", [r.rows[0].id, team, role]);
  return r.rows[0].id as string;
}

const call = (user: string, method: "GET" | "POST" | "PATCH", url: string, payload?: any, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${signToken(ids[user])}`, ...headers } });

async function newItem(as = "lead", extra: object = {}) {
  const res = await call(as, "POST", "/api/items", { teamId, title: "Payment stuck", ...extra });
  expect(res.statusCode).toBe(201);
  return res.json();
}

beforeAll(async () => {
  await migrate();
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE notifications, outbox, idempotency_keys, activity_events, work_items, memberships, teams, users CASCADE");
  teamId = (await pool.query("INSERT INTO teams (name) VALUES ('Support') RETURNING id")).rows[0].id;
  otherTeamId = (await pool.query("INSERT INTO teams (name) VALUES ('Finance') RETURNING id")).rows[0].id;
  await mkUser("lead", "lead");
  await mkUser("member", "member");
  await mkUser("viewer", "viewer");
  await mkUser("outsider"); // belongs to no team
});

describe("concurrent claim", () => {
  it("lets exactly one of many simultaneous claimers win", async () => {
    const item = await newItem();
    const names = Array.from({ length: 10 }, (_, i) => `racer${i}`);
    for (const n of names) await mkUser(n, "member");
    const results = await Promise.all(names.map((n) => call(n, "POST", `/api/items/${item.id}/claim`)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);
    const owner = (await pool.query("SELECT assignee_id FROM work_items WHERE id=$1", [item.id])).rows[0].assignee_id;
    expect(names.map((n) => ids[n])).toContain(owner);
    const events = await pool.query("SELECT count(*)::int n FROM activity_events WHERE item_id=$1 AND type='assigned'", [item.id]);
    expect(events.rows[0].n).toBe(1);
  });

  it("treats a repeated claim by the same user as a no-op", async () => {
    const item = await newItem();
    expect((await call("member", "POST", `/api/items/${item.id}/claim`)).statusCode).toBe(200);
    expect((await call("member", "POST", `/api/items/${item.id}/claim`)).statusCode).toBe(200);
    const events = await pool.query("SELECT count(*)::int n FROM activity_events WHERE item_id=$1 AND type='assigned'", [item.id]);
    expect(events.rows[0].n).toBe(1);
  });
});

describe("stale updates", () => {
  it("rejects an edit made against an old version and returns the current item", async () => {
    const item = await newItem();
    const first = await call("lead", "PATCH", `/api/items/${item.id}`, { version: item.version, title: "A" });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(item.version + 1);
    const stale = await call("lead", "PATCH", `/api/items/${item.id}`, { version: item.version, title: "B" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_CONFLICT");
    expect(stale.json().error.details.current.title).toBe("A");
  });

  it("lets only one of two simultaneous edits with the same version succeed", async () => {
    const item = await newItem();
    const [a, b] = await Promise.all([
      call("lead", "PATCH", `/api/items/${item.id}`, { version: item.version, title: "from A" }),
      call("lead", "PATCH", `/api/items/${item.id}`, { version: item.version, title: "from B" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });
});

describe("idempotent create", () => {
  it("creates one item when the same key is sent concurrently", async () => {
    const key = { "idempotency-key": "abc-123" };
    const body = { teamId, title: "Retry me" };
    const results = await Promise.all([1, 2, 3].map(() => call("lead", "POST", "/api/items", body, key)));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const n = await pool.query("SELECT count(*)::int n FROM work_items");
    expect(n.rows[0].n).toBe(1);
  });

  it("rejects reuse of a key for a different request", async () => {
    const item = await newItem();
    const key = { "idempotency-key": "same" };
    await call("lead", "POST", "/api/items", { teamId, title: "x" }, key);
    const res = await call("lead", "POST", `/api/items/${item.id}/claim`, undefined, key);
    expect(res.statusCode).toBe(422);
  });
});

describe("authorization", () => {
  it("hides items from users outside the team (404, not 403)", async () => {
    const item = await newItem();
    expect((await call("outsider", "GET", `/api/items/${item.id}`)).statusCode).toBe(404);
    expect((await call("outsider", "POST", `/api/items/${item.id}/claim`)).statusCode).toBe(404);
    const list = await call("outsider", "GET", "/api/items");
    expect(list.json().items).toHaveLength(0);
  });

  it("is enforced per team: a lead elsewhere has no power here", async () => {
    await mkUser("otherLead", "lead", otherTeamId);
    const item = await newItem();
    const res = await call("otherLead", "POST", `/api/items/${item.id}/assign`, { assigneeId: ids.member, version: item.version });
    expect(res.statusCode).toBe(404);
  });

  it("stops viewers from writing and members from lead-only actions", async () => {
    const item = await newItem();
    expect((await call("viewer", "POST", `/api/items/${item.id}/comments`, { body: "hi" })).statusCode).toBe(403);
    expect((await call("viewer", "POST", `/api/items/${item.id}/claim`)).statusCode).toBe(403);
    expect((await call("member", "POST", `/api/items/${item.id}/assign`, { assigneeId: ids.member, version: item.version })).statusCode).toBe(403);
    expect((await call("viewer", "POST", "/api/items", { teamId, title: "nope" })).statusCode).toBe(403);
  });

  it("will not assign to a viewer or a non-member", async () => {
    const item = await newItem();
    const res = await call("lead", "POST", `/api/items/${item.id}/assign`, { assigneeId: ids.viewer, version: item.version });
    expect(res.statusCode).toBe(422);
  });
});

describe("workflow enforcement", () => {
  it("needs lead approval to finish work and rejects impossible moves", async () => {
    const item = await newItem();
    const claimed = (await call("member", "POST", `/api/items/${item.id}/claim`)).json();
    expect(claimed.status).toBe("IN_PROGRESS");
    const skip = await call("member", "POST", `/api/items/${item.id}/transition`, { to: "DONE", version: claimed.version });
    expect(skip.statusCode).toBe(422);
    const review = await call("member", "POST", `/api/items/${item.id}/transition`, { to: "IN_REVIEW", version: claimed.version });
    expect(review.statusCode).toBe(200);
    const selfApprove = await call("member", "POST", `/api/items/${item.id}/transition`, { to: "DONE", version: review.json().version });
    expect(selfApprove.statusCode).toBe(403);
    const approve = await call("lead", "POST", `/api/items/${item.id}/transition`, { to: "DONE", version: review.json().version });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("DONE");
  });
});

describe("history", () => {
  it("records every change and cannot be edited or deleted", async () => {
    const item = await newItem();
    await call("member", "POST", `/api/items/${item.id}/claim`);
    await call("lead", "POST", `/api/items/${item.id}/comments`, { body: "looking" });
    const ev = await call("lead", "GET", `/api/items/${item.id}/events`);
    const types = ev.json().events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["created", "assigned", "status_changed", "comment"]));
    await expect(pool.query("DELETE FROM activity_events")).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE activity_events SET type='x'")).rejects.toThrow(/append-only/);
  });
});

describe("outbox worker", () => {
  it("creates notifications and does not duplicate them when a row is processed twice", async () => {
    const item = await newItem("member"); // reporter = member
    await call("lead", "POST", `/api/items/${item.id}/comments`, { body: "ping" });
    await processBatch(50);
    const count = async () => (await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1", [ids.member])).rows[0].n;
    const before = await count();
    expect(before).toBeGreaterThan(0);
    // Simulate at-least-once delivery: the same messages are handled again.
    await pool.query("UPDATE outbox SET processed_at = NULL");
    await processBatch(50);
    expect(await count()).toBe(before);
  });

  it("never notifies people about their own actions", async () => {
    const item = await newItem("lead");
    await call("lead", "POST", `/api/items/${item.id}/comments`, { body: "note to self" });
    await processBatch(50);
    const n = await pool.query("SELECT count(*)::int n FROM notifications WHERE user_id=$1", [ids.lead]);
    expect(n.rows[0].n).toBe(0);
  });

  it("retries a failing message with backoff and parks it after repeated failures", async () => {
    await pool.query("INSERT INTO outbox (type, payload) VALUES ('does.not.exist', '{}')");
    expect(await processBatch()).toBe(1);
    let row = (await pool.query("SELECT attempts, run_at > now() AS delayed, failed_at FROM outbox")).rows[0];
    expect(row.attempts).toBe(1);
    expect(row.delayed).toBe(true);
    expect(row.failed_at).toBeNull();
    for (let i = 0; i < 4; i++) {
      await pool.query("UPDATE outbox SET run_at = now()");
      await processBatch();
    }
    row = (await pool.query("SELECT attempts, failed_at FROM outbox")).rows[0];
    expect(row.attempts).toBe(5);
    expect(row.failed_at).not.toBeNull();
  });
});

describe("listing", () => {
  it("paginates with a stable cursor and filters by search text", async () => {
    for (let i = 0; i < 7; i++) await newItem("lead", { title: i % 2 ? `Refund case ${i}` : `Login issue ${i}` });
    const p1 = (await call("lead", "GET", "/api/items?limit=3")).json();
    const p2 = (await call("lead", "GET", `/api/items?limit=3&cursor=${p1.nextCursor}`)).json();
    const p3 = (await call("lead", "GET", `/api/items?limit=3&cursor=${p2.nextCursor}`)).json();
    const all = [...p1.items, ...p2.items, ...p3.items].map((i: any) => i.id);
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
    expect(p3.nextCursor).toBeNull();
    const found = (await call("lead", "GET", "/api/items?q=refund")).json();
    expect(found.items).toHaveLength(3);
  });
});

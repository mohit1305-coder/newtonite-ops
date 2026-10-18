import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import { pool, tx } from "./db";
import { authenticate, signToken, verifyPassword } from "./auth";
import { HttpError, notFound } from "./errors";
import { requireTeamRole } from "./authz";
import { withIdempotency, type Result } from "./idempotency";
import { PRIORITIES, STATUSES } from "./workflow";
import * as items from "./items";

const uuid = z.string().uuid();
const priority = z.enum(PRIORITIES);
const idParams = z.object({ id: uuid });

const createBody = z.object({
  teamId: uuid,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(""),
  priority: priority.default("MEDIUM"),
  dueAt: z.string().datetime().nullable().default(null),
});
const updateBody = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10000).optional(),
  priority: priority.optional(),
  dueAt: z.string().datetime().nullable().optional(),
});
const assignBody = z.object({ assigneeId: uuid.nullable(), version: z.number().int().positive() });
const transitionBody = z.object({
  to: z.enum(STATUSES),
  version: z.number().int().positive(),
  note: z.string().max(1000).optional(),
});
const commentBody = z.object({ body: z.string().trim().min(1).max(5000) });
const csv = (s?: string) => (s ? s.split(",").filter(Boolean) : undefined);

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError)
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError)
      return reply.status(400).send({ error: { code: "VALIDATION", message: "Invalid request", details: err.flatten() } });
    if (err.code === "22P02") // invalid text representation (e.g. malformed id)
      return reply.status(400).send({ error: { code: "VALIDATION", message: "Malformed value" } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  /* ---------------- auth ---------------- */
  app.post("/api/auth/login", async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const r = await pool.query("SELECT id, name, email, password_hash FROM users WHERE email = $1", [
      body.email.toLowerCase(),
    ]);
    const u = r.rows[0];
    if (!u || !verifyPassword(body.password, u.password_hash))
      throw new HttpError(401, "BAD_CREDENTIALS", "Wrong email or password");
    return { token: signToken(u.id), user: { id: u.id, name: u.name, email: u.email } };
  });

  /* Everything below requires a valid token. */
  const authed = (handler: (userId: string, req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => handler(authenticate(req), req, reply);

  app.get("/api/me", authed(async (userId) => {
    const u = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [userId]);
    if (!u.rows[0]) throw new HttpError(401, "UNAUTHENTICATED", "Unknown user");
    const m = await pool.query(
      `SELECT t.id AS team_id, t.name AS team_name, m.role FROM memberships m
       JOIN teams t ON t.id = m.team_id WHERE m.user_id = $1 ORDER BY t.name`,
      [userId],
    );
    return {
      user: u.rows[0],
      memberships: m.rows.map((r) => ({ teamId: r.team_id, teamName: r.team_name, role: r.role })),
    };
  }));

  app.get("/api/teams/:id/members", authed(async (userId, req) => {
    const { id } = idParams.parse(req.params);
    await requireTeamRole(pool, userId, id);
    const r = await pool.query(
      `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1 ORDER BY u.name`,
      [id],
    );
    return { members: r.rows };
  }));

  /* ---------------- items ---------------- */
  app.get("/api/dashboard", authed((userId) => items.dashboard(userId)));

  app.get("/api/items", authed(async (userId, req) => {
    const q = z
      .object({
        teamId: uuid.optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        assignee: z.union([z.literal("me"), z.literal("none"), uuid]).optional(),
        q: z.string().max(200).optional(),
        overdue: z.enum(["1", "true"]).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    return items.listItems(userId, {
      teamId: q.teamId,
      status: csv(q.status)?.filter((s) => (STATUSES as readonly string[]).includes(s)),
      priority: csv(q.priority)?.filter((s) => (PRIORITIES as readonly string[]).includes(s)),
      assignee: q.assignee,
      q: q.q?.trim() || undefined,
      overdue: !!q.overdue,
      cursor: q.cursor,
      limit: q.limit,
    });
  }));

  app.get("/api/items/:id", authed(async (userId, req) => {
    const { id } = idParams.parse(req.params);
    return items.getItem(pool, userId, id);
  }));

  app.get("/api/items/:id/events", authed(async (userId, req) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({ before: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(req.query);
    return items.listEvents(userId, id, q.before, q.limit);
  }));

  /** Run a write in a transaction, optionally deduplicated by Idempotency-Key. */
  async function write<T>(
    userId: string,
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    status: number,
    fn: (c: import("pg").PoolClient) => Promise<T>,
  ) {
    const raw = req.headers["idempotency-key"];
    const key = typeof raw === "string" && raw.length > 0 ? raw.slice(0, 200) : undefined;
    const result: Result<T> = await tx((c) =>
      withIdempotency(c, userId, key, scope, async () => ({ status, body: await fn(c) })),
    );
    if (result.replayed) reply.header("Idempotent-Replayed", "true");
    return reply.status(result.status).send(result.body);
  }

  app.post("/api/items", authed(async (userId, req, reply) => {
    const body = createBody.parse(req.body);
    return write(userId, req, reply, "POST /items", 201, (c) => items.createItem(c, userId, body));
  }));

  app.patch("/api/items/:id", authed(async (userId, req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body);
    return write(userId, req, reply, `PATCH /items/${id}`, 200, (c) => items.updateItem(c, userId, id, body));
  }));

  app.post("/api/items/:id/claim", authed(async (userId, req, reply) => {
    const { id } = idParams.parse(req.params);
    return write(userId, req, reply, `claim ${id}`, 200, (c) => items.claimItem(c, userId, id));
  }));

  app.post("/api/items/:id/assign", authed(async (userId, req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = assignBody.parse(req.body);
    return write(userId, req, reply, `assign ${id}`, 200, (c) => items.assignItem(c, userId, id, body));
  }));

  app.post("/api/items/:id/transition", authed(async (userId, req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = transitionBody.parse(req.body);
    return write(userId, req, reply, `transition ${id}`, 200, (c) => items.transitionItem(c, userId, id, body));
  }));

  app.post("/api/items/:id/comments", authed(async (userId, req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = commentBody.parse(req.body);
    return write(userId, req, reply, `comment ${id}`, 201, (c) => items.addComment(c, userId, id, body.body));
  }));

  /* ---------------- notifications ---------------- */
  app.get("/api/notifications", authed(async (userId) => {
    const r = await pool.query(
      `SELECT id, item_id, message, read_at, created_at FROM notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [userId],
    );
    const unread = await pool.query(
      "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [userId],
    );
    return {
      unread: unread.rows[0].n,
      notifications: r.rows.map((n) => ({
        id: n.id, itemId: n.item_id, message: n.message, readAt: n.read_at, createdAt: n.created_at,
      })),
    };
  }));

  app.post("/api/notifications/read-all", authed(async (userId) => {
    await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [userId]);
    return { ok: true };
  }));

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }));
  void notFound; // re-exported helper kept for route modules
  return app;
}

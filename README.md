# Ops Desk

An internal web app for coordinating operational work: requests, ownership, approvals and a full history, for many teams at once. Built for the Newtonite "Operations Under Pressure" challenge.

**Stack:** Node + TypeScript + Fastify, PostgreSQL, React + Vite. No Redis or queue broker: the async work uses a transactional outbox in Postgres.

## Run it

Requirements: Node 20+, Docker.

```bash
# 1. database (also creates a second DB, ops_test, for the tests)
docker compose up -d db

# 2. backend (applies migrations on start, runs the notification worker in-process)
cd backend
npm install
npm run seed        # demo data: 5 users, 3 teams, 900 work items
npm run dev         # http://localhost:3000

# 3. frontend (new terminal)
cd web
npm install
npm run dev         # http://localhost:5173
```

Demo logins (password `password123`):

| User | Roles |
|---|---|
| alice@example.com | lead in Support and Engineering |
| bob@example.com | member in Support |
| carol@example.com | member in Engineering, **viewer** in Support |
| dave@example.com | lead in Finance, member in Support |
| erin@example.com | member in Finance and Engineering |

Try it with two browsers (or a private window) logged in as different users and open the same item.

## Tests

```bash
cd backend
npm run test:unit   # pure rules, no database needed
npm test            # unit + integration (needs `docker compose up -d db`)
```

## What it does

- Work items with status, priority, due date, owner, team, and a full append-only history (comments live in the same timeline).
- Roles per team: **viewer** (read only), **member** (create, comment, claim, edit/move items they own or reported), **lead** (assign, edit, approve completion, reopen).
- "Needs attention" dashboard: assigned to me, awaiting my approval, high priority and unassigned, overdue, stale.
- All-work list with filters, full-text search and cursor pagination.
- Notifications created asynchronously by a worker.

## Structure

```
backend/src/workflow.ts     status state machine (pure)
backend/src/authz.ts        permission table + team role lookup
backend/src/items.ts        all reads/writes of work items, one transaction each
backend/src/idempotency.ts  Idempotency-Key handling
backend/src/outbox.ts       outbox worker (retry, backoff, dead-letter)
backend/src/app.ts          HTTP routes, validation, error mapping
backend/migrations/         SQL schema
web/src/pages/              Dashboard, Items, ItemDetail, NewItem
```

## API summary

| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/login | returns a JWT |
| GET | /api/me | user + team roles |
| GET | /api/dashboard | needs-attention sections |
| GET | /api/items | filters: teamId, status, priority, assignee, q, overdue; `cursor`, `limit` |
| POST | /api/items | `Idempotency-Key` supported |
| GET | /api/items/:id | includes `version` and `permissions` for this user |
| PATCH | /api/items/:id | body must include `version`; 409 `VERSION_CONFLICT` if stale |
| POST | /api/items/:id/claim | 409 `ALREADY_ASSIGNED` if someone else got it first |
| POST | /api/items/:id/assign | lead only, needs `version` |
| POST | /api/items/:id/transition | `{to, version, note?}`, workflow rules enforced |
| POST | /api/items/:id/comments | |
| GET | /api/items/:id/events | history, paged with `before` |
| GET | /api/notifications, POST /api/notifications/read-all | |

## Known limitations

- No real-time push: the detail page polls every 5 s and the dashboard every 20 s. WebSockets/SSE would be the next step.
- Search is Postgres full-text on title + description only (no comments, no typo tolerance). List order is always "most recently updated".
- Team and user administration (creating teams, changing roles) is done via SQL/seed; there is no admin UI.
- No rate limiting, password reset, refresh tokens or audit of failed logins.
- The worker only creates in-app notifications; email/Slack delivery would be added as new outbox handlers.
- Dashboard queries are bounded and indexed but not cached; at much larger scale they would move to a read replica or materialised counts.
- The history table is one partition; at very large volume it should be partitioned by time.
- I could not run the full stack in the sandbox where this was generated, so run `npm test` first and fix anything environment-specific.

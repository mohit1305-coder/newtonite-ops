# Engineering decisions

## 1. PostgreSQL as the single source of truth (including the "queue")

**Decision.** One Postgres database holds items, history, idempotency keys and the async outbox. No Redis, Kafka or separate search engine.

**Why.** Every correctness requirement here (atomic claim, stale-write rejection, history written with the change, notifications that cannot be lost) is easiest to guarantee with a single ACID transaction. Postgres also covers full-text search (`tsvector` + GIN), partial indexes for "active work", and `FOR UPDATE SKIP LOCKED` for the worker.

**Trade-off.** Fewer moving parts and stronger guarantees now, at the cost of a ceiling: heavy search or very high event throughput would eventually justify OpenSearch or a real broker. The module boundaries (`items.ts`, `outbox.ts`) make that swap local.

## 2. Concurrency: row locks, a version column, and idempotency keys

**Decision.** Three separate mechanisms for three different problems:
- *Two people take the same work* (`claim`): the item row is locked with `SELECT ... FOR UPDATE`, so claims are serialised. The first wins, the rest get `409 ALREADY_ASSIGNED` with the current item. Claiming something already yours is a no-op.
- *Someone edits an old copy* (`PATCH`, `assign`, `transition`): every item has a `version`. Clients send the version they saw; a mismatch returns `409 VERSION_CONFLICT` plus the current item, and the UI lets the user keep or discard their edits. Comments do not bump the version, so discussion never causes edit conflicts.
- *The user is unsure whether it worked* (create, and all POST actions): an `Idempotency-Key` header. The key is inserted inside the same transaction as the work, so a concurrent duplicate blocks on the primary key and then returns the stored response instead of repeating it.

**Why not just last-write-wins?** It silently loses data, which is exactly the failure the brief describes.

**Trade-off.** Pessimistic locking on a single row is simple and correct, but a very hot item serialises writers. That is acceptable: contention is per item, not global. The UI also shows optimistic state for "Take this", but the server's answer always replaces it.

## 3. Authorization lives in the service layer and is checked per resource

**Decision.** Roles are stored per *team membership* (`viewer`, `member`, `lead`), not globally. A single `can(role, action, ctx)` table decides every write, and the item's own team determines which role applies. The JWT proves identity only; roles are read from the database on each request, so a role change applies immediately. Users outside a team get `404`, not `403`, so item existence is not leaked. The `permissions` object in the item response exists only so the UI can mirror the rules; it is never trusted.

**Why.** "Lead in Support" must not grant anything in Finance. Putting the check in the same function that locks the row means there is no route that can forget it.

**Trade-off.** One extra membership lookup per request (indexed primary-key read) in exchange for instant revocation. A small cache would be the first optimisation if it ever mattered.

## 4. Append-only history, written in the same transaction; comments are events

**Decision.** Every change inserts a row in `activity_events` in the same transaction as the change. A database trigger rejects `UPDATE` and `DELETE` on that table. Comments are stored as events rather than in a second table.

**Why.** "Important actions should not silently disappear" should hold even if application code has a bug. One timeline table also makes the history view a single indexed query, paged by id.

**Trade-off.** Comments cannot be edited or deleted (a deliberate choice for an audit trail; a correction is a new comment). Event `data` is JSON, so old events keep the shape they were written with. The table will grow without bound and should be partitioned by time at scale.

## 5. Asynchronous work through a transactional outbox, at-least-once with idempotent handlers

**Decision.** Notifications are not sent inline. The change and an `outbox` row commit together. A worker claims rows with `FOR UPDATE SKIP LOCKED`, runs each handler in a savepoint, and on failure reschedules with exponential backoff; after 5 attempts the row is parked (`failed_at`) for a human. Handlers insert notifications with a unique `dedupe_key` (`outboxId:userId`), so processing the same row twice creates no duplicates.

**Why.** The request stays fast and cannot fail because notification delivery failed, and a crash between "saved" and "notified" cannot lose a notification. Several workers can run side by side.

**Trade-off.** Delivery is delayed by up to the poll interval (1 s) and ordering across items is not guaranteed. Exactly-once is not attempted; at-least-once plus idempotency is simpler and sufficient.

## What I intentionally did not build

Real-time push (polling instead), admin screens, email/Slack delivery, SLA timers, attachments, and a generic permission editor. I preferred a smaller system whose failure behaviour is tested over a larger one with many half-finished features.

## What I would do next

SSE for live updates, an admin UI for teams and roles, a stale/overdue sweeper job through the same outbox, partitioned history, per-team search ranking, and rate limiting.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A user can belong to many teams with a different role in each.
CREATE TYPE team_role AS ENUM ('viewer', 'member', 'lead');

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    team_role NOT NULL,
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team_idx ON memberships (team_id);

CREATE TABLE work_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN','IN_PROGRESS','BLOCKED','IN_REVIEW','DONE','CANCELLED')),
  priority    text NOT NULL DEFAULT 'MEDIUM'
              CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  reporter_id uuid NOT NULL REFERENCES users(id),
  assignee_id uuid REFERENCES users(id),
  due_at      timestamptz,
  -- Optimistic concurrency token: bumped on every change to the item's fields.
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
                to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))
              ) STORED
);

-- List/pagination: newest activity first within the teams a user can see.
CREATE INDEX work_items_team_updated_idx ON work_items (team_id, updated_at DESC, id DESC);
CREATE INDEX work_items_updated_idx      ON work_items (updated_at DESC, id DESC);
-- "My work" and "needs attention" queries only care about active items.
CREATE INDEX work_items_assignee_active_idx ON work_items (assignee_id)
  WHERE status NOT IN ('DONE','CANCELLED');
CREATE INDEX work_items_unassigned_idx ON work_items (team_id, priority)
  WHERE assignee_id IS NULL AND status = 'OPEN';
CREATE INDEX work_items_due_active_idx ON work_items (due_at)
  WHERE due_at IS NOT NULL AND status NOT IN ('DONE','CANCELLED');
CREATE INDEX work_items_search_idx ON work_items USING gin (search);

-- Append-only history (also holds comments: type = 'comment').
CREATE TABLE activity_events (
  id         bigserial PRIMARY KEY,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  team_id    uuid NOT NULL REFERENCES teams(id),
  actor_id   uuid REFERENCES users(id),
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_events_item_idx ON activity_events (item_id, id DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_immutable
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Retried POSTs with the same Idempotency-Key return the stored response.
CREATE TABLE idempotency_keys (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  scope       text NOT NULL,
  status_code integer,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Transactional outbox: written in the same transaction as the change it describes.
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  run_at       timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failed_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (run_at)
  WHERE processed_at IS NULL AND failed_at IS NULL;

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    uuid NOT NULL REFERENCES work_items(id),
  message    text NOT NULL,
  -- Makes the worker idempotent: the same outbox row never notifies a user twice.
  dedupe_key text NOT NULL UNIQUE,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

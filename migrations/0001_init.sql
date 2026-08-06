-- migrations/0001_init.sql

CREATE TABLE inbox (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('processed','ignored')),
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- 30-day prune sweep (design.md §5.2) scans by age.
CREATE INDEX idx_inbox_received_at ON inbox (received_at);

CREATE TABLE parents (
  parent_id TEXT PRIMARY KEY,
  timezone  TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  locale    TEXT NOT NULL DEFAULT 'vi-VN'
);

CREATE TABLE children (
  child_id            TEXT PRIMARY KEY,
  parent_id           TEXT NOT NULL,
  name                TEXT NOT NULL,
  identity_updated_at TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX idx_children_parent_id ON children (parent_id);

CREATE TABLE push_tokens (
  token        TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL UNIQUE,
  parent_id    TEXT NOT NULL,
  platform     TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  disabled_at  TEXT
);
CREATE INDEX idx_push_tokens_parent_id ON push_tokens (parent_id);

CREATE TABLE preferences (
  parent_id        TEXT PRIMARY KEY,
  progress_enabled INTEGER NOT NULL DEFAULT 1,
  weekly_enabled   INTEGER NOT NULL DEFAULT 1,
  quiet_start      TEXT,
  quiet_end        TEXT,
  daily_cap        INTEGER NOT NULL DEFAULT 10
);

-- Append-only pending membership for coalescing (design.md §4.5 step 1).
-- window_key = child_id for scope='child', parent_id for scope='parent'.
CREATE TABLE coalesce_events (
  event_id     TEXT PRIMARY KEY,
  window_key   TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('child','parent')),
  child_id     TEXT,
  parent_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  arrived_at   TEXT NOT NULL
);
-- Load-bearing for the flush query (design.md §4.5 step 2): grouped by
-- window_key, ordered by arrived_at.
CREATE INDEX idx_coalesce_events_window ON coalesce_events (window_key, arrived_at);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT NOT NULL,
  child_id      TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  enqueued_at   TEXT,
  state         TEXT NOT NULL CHECK (state IN (
                  'scheduled','enqueued','done','deferred_quiet',
                  'suppressed_cap','suppressed_dark','canceled'
                )),
  dedupe_key    TEXT NOT NULL UNIQUE
);
-- The hourly sweeper (design.md §4.5 step 4) scans scheduled rows older than
-- 15 min; the quiet-end flush scans deferred_quiet rows for a parent+date.
CREATE INDEX idx_notifications_state_scheduled ON notifications (state, scheduled_for);
CREATE INDEX idx_notifications_parent_id ON notifications (parent_id);

CREATE TABLE deliveries (
  notification_id TEXT NOT NULL,
  token            TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','accepted','failed','canceled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  fcm_message_name TEXT,
  PRIMARY KEY (notification_id, token)
);
CREATE INDEX idx_deliveries_token ON deliveries (token);

CREATE TABLE caps (
  parent_id  TEXT NOT NULL,
  local_date TEXT NOT NULL,
  daily_cap  INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (parent_id, local_date)
);

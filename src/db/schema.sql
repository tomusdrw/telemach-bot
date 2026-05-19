CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  email         TEXT,
  status        TEXT NOT NULL
                 CHECK (status IN ('PENDING_EMAIL','PENDING_APPROVAL','APPROVED','REJECTED')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  timezone      TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL,
  chat_message_id INTEGER,
  event           TEXT NOT NULL,
  details         TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user_time
  ON audit_log (telegram_id, created_at DESC);

-- In-flight media-group items, persisted on receipt and deleted on flush.
-- Survives bot restart so an interrupted group resumes after a crash.
CREATE TABLE IF NOT EXISTS media_group_pending (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        TEXT NOT NULL,
  telegram_id     INTEGER NOT NULL,
  chat_id         INTEGER NOT NULL,
  message_id      INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,    -- serialized PersistedItem (see forward.ts)
  received_at     INTEGER NOT NULL  -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_mgp_group ON media_group_pending (group_id);
CREATE INDEX IF NOT EXISTS idx_mgp_received ON media_group_pending (received_at);

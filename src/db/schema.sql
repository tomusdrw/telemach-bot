CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  email         TEXT,
  status        TEXT NOT NULL
                 CHECK (status IN ('PENDING_EMAIL','PENDING_APPROVAL','APPROVED','REJECTED')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
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

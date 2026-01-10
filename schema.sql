CREATE TABLE IF NOT EXISTS uploads (
  id            BIGSERIAL PRIMARY KEY,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  original_name TEXT NOT NULL,
  content       TEXT NOT NULL,

  snapshot_at   TIMESTAMPTZ NULL,
  server_name   TEXT NULL
);

CREATE TABLE IF NOT EXISTS db_sizes (
  id           BIGSERIAL PRIMARY KEY,
  upload_id    BIGINT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,

  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_at  TIMESTAMPTZ NULL,

  server_name  TEXT NULL,
  db_name      TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  size_pretty  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_db_sizes_server_db_captured
  ON db_sizes (server_name, db_name, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_db_sizes_server_db_snapshot
  ON db_sizes (server_name, db_name, snapshot_at DESC);

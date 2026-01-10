CREATE TABLE IF NOT EXISTS uploads (
  id            BIGSERIAL PRIMARY KEY,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  original_name TEXT NOT NULL,
  content       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_sizes (
  id           BIGSERIAL PRIMARY KEY,
  upload_id    BIGINT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  db_name      TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  size_pretty  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_db_sizes_db_name_captured_at
  ON db_sizes (db_name, captured_at DESC);

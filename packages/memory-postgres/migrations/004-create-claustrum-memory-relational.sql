-- @claustrum/memory-postgres — relational (emotional/social) signals table.
--
-- Append-only: relational signals are observations, not facts. The recall
-- query reads the most recent N signals for the snapshot. Two indexes:
--   * (customer_id, observed_at DESC) — the default snapshot fetch
--   * (customer_id, signal_kind, observed_at DESC) — used when a downstream
--     consumer wants "all sentiment signals" or "all rapport markers"

CREATE TABLE IF NOT EXISTS claustrum_memory_relational (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  signal_kind  TEXT NOT NULL,
  content      TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_relational_recent
  ON claustrum_memory_relational (customer_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_relational_kind_recent
  ON claustrum_memory_relational (customer_id, signal_kind, observed_at DESC);

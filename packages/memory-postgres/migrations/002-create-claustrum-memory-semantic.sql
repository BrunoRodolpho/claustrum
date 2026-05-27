-- @claustrum/memory-postgres — semantic facts table.
--
-- Primary key is (customer_id, key) so:
--   * upsert by fact-key is O(1)
--   * there is exactly one "current truth" per fact at the schema level
--   * `WHERE customer_id = $1` scans use the PK index directly
--
-- Confidence index supports the recall query
-- `WHERE customer_id = $1 AND confidence >= 0.3 ORDER BY confidence DESC LIMIT N`,
-- which is how the snapshot filters out low-confidence facts before they
-- reach the prompt composer.

CREATE TABLE IF NOT EXISTS claustrum_memory_semantic (
  customer_id  TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  confidence   DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  tags         TEXT[] NOT NULL DEFAULT '{}',
  recorded_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (customer_id, key)
);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_semantic_confidence
  ON claustrum_memory_semantic (customer_id, confidence DESC);

-- Optional: GIN index on tags for tag-based search. Adopters who don't use
-- tag search can skip this — it costs ~5% on writes.
CREATE INDEX IF NOT EXISTS idx_claustrum_memory_semantic_tags
  ON claustrum_memory_semantic USING GIN (tags);

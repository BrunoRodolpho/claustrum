-- @claustrum/memory-postgres — procedural workflows table.
--
-- Multi-workflow per customer (a customer can have a return-flow, an
-- upgrade-flow, and a refund-flow all distinct). last_used_at NULLs are
-- placed LAST so freshly learned (unused) procedures don't dominate the
-- snapshot — recently used ones outrank.

CREATE TABLE IF NOT EXISTS claustrum_memory_procedural (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  workflow_kind TEXT NOT NULL,
  description   TEXT NOT NULL,
  last_used_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_procedural_recent
  ON claustrum_memory_procedural (customer_id, last_used_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_procedural_kind
  ON claustrum_memory_procedural (customer_id, workflow_kind);

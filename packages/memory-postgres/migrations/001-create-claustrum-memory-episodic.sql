-- @claustrum/memory-postgres — episodic table.
--
-- Partitioned by month on recorded_at. Adopters create partitions via their
-- preferred mechanism (pg_partman recommended for production); the migration
-- creates only the parent. Retention policy is adopter-defined — typical
-- ranges are 90d for chat history, longer for regulated industries.
--
-- Index strategy:
--   1. (customer_id, recorded_at DESC) — the hot-path recall query
--      ("most recent N turns for this customer"). Index walks DESC so the
--      planner doesn't issue a sort.
--   2. (conversation_id, recorded_at) — used by session resumption flows
--      (drill into one conversation's transcript).
--   3. (intent_hash) WHERE intent_hash IS NOT NULL — partial index, narrow
--      because only ~half of turns produce a settled intent. The WHERE clause
--      keeps the index small enough to stay in shared_buffers.
--
-- All indexes are declared on the parent table; Postgres propagates them to
-- partitions automatically.

CREATE TABLE IF NOT EXISTS claustrum_memory_episodic (
  id              BIGSERIAL,
  customer_id     TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_text       TEXT NULL,
  response_text   TEXT NULL,
  decision_kind   TEXT NULL,
  intent_hash     TEXT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_episodic_customer_recent
  ON claustrum_memory_episodic (customer_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_episodic_conversation
  ON claustrum_memory_episodic (conversation_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_claustrum_memory_episodic_intent_hash
  ON claustrum_memory_episodic (intent_hash)
  WHERE intent_hash IS NOT NULL;

-- Companion: adopters create monthly partitions like so. The migration tool
-- (sqitch / dbmate / liquibase / Prisma migrate) should template this.
--
--   CREATE TABLE claustrum_memory_episodic_2026_05
--     PARTITION OF claustrum_memory_episodic
--     FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

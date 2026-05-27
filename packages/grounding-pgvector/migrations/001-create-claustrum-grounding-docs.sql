-- @claustrum/grounding-pgvector — migration 001
--
-- Creates the corpus table consumed by `createPgVectorGroundingProvider`.
-- HNSW index uses cosine distance (`vector_cosine_ops`) to match the
-- `embedding <=> $1::vector` ordering in `retrieve.ts`. Embedding width is
-- 1536 (matches OpenAI `text-embedding-3-small` and most production
-- defaults); adopters with a different model dimension must clone and
-- adjust before applying.
--
-- `CREATE EXTENSION vector` requires superuser. If running under a
-- non-superuser role, ask the DBA to pre-create the extension once.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS claustrum_grounding_docs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_version TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  retrieved_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cgnd_embedding_hnsw
  ON claustrum_grounding_docs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_cgnd_tenant_record
  ON claustrum_grounding_docs (tenant_id, record_id, record_version);

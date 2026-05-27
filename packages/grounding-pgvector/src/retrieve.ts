/**
 * pgvector k-NN retrieval over `claustrum_grounding_docs`.
 *
 * Two-step:
 *   1. Embed the query text via the injected `ModelProvider.embed()`.
 *   2. Run `embedding <=> $1::vector` ordered k-NN over the tenant slice.
 *
 * The embedding is rendered as a literal string `[v0,v1,...]` and passed
 * as a bound parameter; pgvector parses that into a vector via the
 * `::vector` cast inline in the SQL. We do not use the `pgvector` npm
 * formatter because the literal form has zero runtime dep and is exactly
 * what the pgvector docs prescribe.
 *
 * Score semantics: `embedding <=> $1::vector` is cosine *distance* in
 * [0, 2]. We expose `score = 1 - distance` so larger ≈ more similar,
 * matching the {@link RetrievedDoc} contract.
 */

import type { GroundingSource, RetrievedDoc } from "@claustrum/core";
import type { Pool } from "./pool.js";

/** Row shape returned by {@link runKnnQuery}. */
export interface KnnRow {
  readonly id: string;
  readonly source_uri: string;
  readonly record_id: string;
  readonly record_version: string;
  readonly chunk_text: string;
  readonly chunk_index: number;
  readonly distance: number;
  readonly metadata_jsonb: Record<string, unknown> | null;
}

export interface KnnQueryInput {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly embedding: ReadonlyArray<number>;
  readonly k: number;
}

/**
 * Render `[1.2,3.4,...]` for pgvector's text-literal vector form.
 * `JSON.stringify` is intentionally avoided — vectors must not get
 * scientific notation outside pgvector's parser's comfort zone, but more
 * importantly the array form is the documented public surface.
 */
export function formatVectorLiteral(embedding: ReadonlyArray<number>): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Execute the k-NN query. Returns raw rows ordered by ascending cosine
 * distance (closest first). Caller maps to {@link RetrievedDoc}.
 */
export async function runKnnQuery(
  input: KnnQueryInput,
): Promise<ReadonlyArray<KnnRow>> {
  const sql = `SELECT
      id::text AS id,
      source_uri,
      record_id,
      record_version,
      chunk_text,
      chunk_index,
      metadata_jsonb,
      embedding <=> $1::vector AS distance
    FROM claustrum_grounding_docs
    WHERE tenant_id = $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3`;

  const params = [formatVectorLiteral(input.embedding), input.tenantId, input.k];

  const result = await input.pool.query<KnnRow>(sql, params);
  return result.rows;
}

/**
 * Map a raw row to the port's `RetrievedDoc`. `source` is supplied by the
 * caller — pgvector itself is source-agnostic, but the provider tags every
 * doc it retrieves with the configured {@link GroundingSource}.
 */
export function rowToRetrievedDoc(
  row: KnnRow,
  source: GroundingSource,
): RetrievedDoc {
  const score = 1 - row.distance;
  const metadata =
    row.metadata_jsonb === null || row.metadata_jsonb === undefined
      ? undefined
      : row.metadata_jsonb;

  if (metadata === undefined) {
    return {
      id: row.id,
      source,
      recordId: row.record_id,
      recordVersion: row.record_version,
      chunkText: row.chunk_text,
      score,
    };
  }
  return {
    id: row.id,
    source,
    recordId: row.record_id,
    recordVersion: row.record_version,
    chunkText: row.chunk_text,
    score,
    metadata,
  };
}

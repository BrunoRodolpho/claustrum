/**
 * Semantic search — cold path. Not budget-constrained.
 *
 * Reads from semantic + episodic via ILIKE over content. Production adopters
 * with a real workload should swap this for a tsvector + GIN index or a
 * pgvector approach; the function signature is stable so the swap is local.
 *
 * Excluded by design: the operational kind. Operational memory lives in the
 * kernel ledger (conformance CC-005) — surfaced via `recentActions()`, never
 * via free-text search.
 */

import type { MemoryItem } from "@claustrum/core";
import type { PrismaClientLike } from "./types.js";

interface SearchRow {
  readonly source: "semantic" | "episodic";
  readonly id_str: string;
  readonly content: string;
  readonly confidence: number | string | null;
  readonly recorded_at: Date | string;
  readonly tags: ReadonlyArray<string> | null;
}

export async function semanticSearch(
  prisma: PrismaClientLike,
  customerId: string,
  query: { readonly semantic?: string; readonly tags?: ReadonlyArray<string> },
  k: number,
): Promise<ReadonlyArray<MemoryItem>> {
  const term = query.semantic?.trim();
  // Empty queries return empty rather than scanning the whole partition.
  // Tag-only filtering is honored on top of any text term.
  if (!term && (!query.tags || query.tags.length === 0)) {
    return [];
  }

  const pattern = term ? `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;
  const limit = Math.max(1, Math.min(k, 100));
  const tagsParam: string[] | null =
    query.tags && query.tags.length > 0 ? [...query.tags] : null;

  // UNION semantic + episodic. Conservative ILIKE — adopters with real load
  // should replace with a tsvector + GIN index. The interface is the contract,
  // not the SQL.
  const rows = await prisma.$queryRawUnsafe<SearchRow>(
    `
    (
      SELECT 'semantic' AS source,
             key AS id_str,
             key || ': ' || value AS content,
             confidence::float AS confidence,
             recorded_at,
             tags
      FROM claustrum_memory_semantic
      WHERE customer_id = $1
        AND ($2::text IS NULL OR (key || ': ' || value) ILIKE $2)
        AND ($3::text[] IS NULL OR tags && $3)
    )
    UNION ALL
    (
      SELECT 'episodic' AS source,
             id::text AS id_str,
             COALESCE(user_text, '') || ' ' || COALESCE(response_text, '') AS content,
             NULL AS confidence,
             recorded_at,
             NULL::text[] AS tags
      FROM claustrum_memory_episodic
      WHERE customer_id = $1
        AND $2::text IS NOT NULL
        AND (COALESCE(user_text, '') || ' ' || COALESCE(response_text, '')) ILIKE $2
    )
    ORDER BY recorded_at DESC
    LIMIT $4
    `,
    customerId,
    pattern,
    tagsParam,
    limit,
  );

  return rows.map((row): MemoryItem => {
    const createdAt =
      typeof row.recorded_at === "string"
        ? row.recorded_at
        : row.recorded_at.toISOString();
    const tags = row.tags && row.tags.length > 0 ? row.tags : undefined;
    return {
      id: `${row.source.slice(0, 3)}-${row.id_str}`,
      kind: row.source,
      content: row.content,
      createdAt,
      ...(row.confidence !== null
        ? { confidence: Number(row.confidence) }
        : {}),
      ...(tags ? { tags } : {}),
    };
  });
}

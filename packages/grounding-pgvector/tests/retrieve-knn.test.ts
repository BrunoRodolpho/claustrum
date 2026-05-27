/**
 * `retrieve()` with a mocked `Pool` + mocked `ModelProvider`:
 *  - rows come back ordered (smallest distance first → highest score)
 *  - the returned `RetrievedDocs.modelId` is the configured value
 *  - the SQL receives the vector literal `[v0,v1,...]` and the tenant id
 *  - `defaultK` and `GroundingSpec.k` are both honoured
 *
 * Also covers `attestGrounding`: a claim with a matching chunk produces a
 * proof; a claim with no match produces nothing (kernel handles refusal).
 */

import { describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  ModelProvider,
  Perception,
} from "@claustrum/core";
import { createPgVectorGroundingProvider } from "../src/pgvector-grounding-provider.js";
import { formatVectorLiteral, type KnnRow } from "../src/retrieve.js";
import type { Pool, QueryResult } from "../src/pool.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

interface RecordedQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

function mockPool(rows: ReadonlyArray<KnnRow>): {
  pool: Pool;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const pool: Pool = {
    async query<R>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<QueryResult<R>> {
      queries.push({ sql: text, params: params ?? [] });
      return { rows: rows as unknown as ReadonlyArray<R> };
    },
  };
  return { pool, queries };
}

function mockModelProvider(embedding: number[]): ModelProvider {
  return {
    embed: async () => embedding,
    complete: async () => {
      throw new Error("complete not used in retrieve tests");
    },
    stream: (_req: CompletionRequest) => {
      throw new Error("stream not used in retrieve tests");
    },
  };
}

const perception: Perception = {
  text: "What is the conductor metaphor?",
  channel: "web",
  receivedAt: "2025-01-01T00:00:00.000Z",
};

function row(overrides: Partial<KnnRow> = {}): KnnRow {
  return {
    id: "1",
    source_uri: "doc://corpus/1",
    record_id: "rec-1",
    record_version: "v1",
    chunk_text: "The conductor is the metaphor for global broadcast.",
    chunk_index: 0,
    distance: 0.1,
    metadata_jsonb: { topic: "cognition" },
    ...overrides,
  };
}

// ── retrieve() ─────────────────────────────────────────────────────────────

describe("retrieve()", () => {
  it("returns RetrievedDocs with rows ordered by ascending distance and stamps modelId", async () => {
    const rows: KnnRow[] = [
      row({ id: "1", distance: 0.05 }),
      row({ id: "2", distance: 0.2 }),
      row({ id: "3", distance: 0.9 }),
    ];
    const { pool, queries } = mockPool(rows);

    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0.1, 0.2, 0.3]),
      modelId: "text-embedding-3-small",
      tenantId: "tenant-A",
    });

    const result = await provider.retrieve(perception);

    expect(result.modelId).toBe("text-embedding-3-small");
    expect(result.docs).toHaveLength(3);
    expect(result.docs[0]!.id).toBe("1");
    expect(result.docs[1]!.id).toBe("2");
    expect(result.docs[2]!.id).toBe("3");
    // score = 1 - distance, larger ≈ more similar
    expect(result.docs[0]!.score).toBeCloseTo(0.95, 10);
    expect(result.docs[2]!.score).toBeCloseTo(0.1, 10);
    // retrievedAt is an ISO-8601 string
    expect(result.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Exactly one query, with the expected params.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.params[0]).toBe(formatVectorLiteral([0.1, 0.2, 0.3]));
    expect(queries[0]!.params[1]).toBe("tenant-A");
    expect(queries[0]!.params[2]).toBe(8); // defaultK
    expect(queries[0]!.sql).toContain("claustrum_grounding_docs");
    expect(queries[0]!.sql).toContain("embedding <=> $1::vector");
    expect(queries[0]!.sql).toContain("WHERE tenant_id = $2");
    expect(queries[0]!.sql).toContain("LIMIT $3");
  });

  it("honours GroundingSpec.k over defaultK", async () => {
    const { pool, queries } = mockPool([row()]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([1, 0]),
      modelId: "m",
      tenantId: "t",
      defaultK: 3,
    });

    await provider.retrieve(perception, { sources: ["external"], k: 12 });
    expect(queries[0]!.params[2]).toBe(12);
  });

  it("falls back to defaultK when GroundingSpec is absent", async () => {
    const { pool, queries } = mockPool([row()]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([1, 0]),
      modelId: "m",
      tenantId: "t",
      defaultK: 5,
    });

    await provider.retrieve(perception);
    expect(queries[0]!.params[2]).toBe(5);
  });

  it("propagates metadata when present and elides when null", async () => {
    const { pool } = mockPool([
      row({ id: "with", metadata_jsonb: { k: "v" } }),
      row({ id: "without", metadata_jsonb: null }),
    ]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0]),
      modelId: "m",
      tenantId: "t",
    });
    const result = await provider.retrieve(perception);
    expect(result.docs[0]!.metadata).toEqual({ k: "v" });
    expect(result.docs[1]!.metadata).toBeUndefined();
  });

  it("tags retrieved docs with the configured source", async () => {
    const { pool } = mockPool([row()]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0]),
      modelId: "m",
      tenantId: "t",
      source: "policy",
    });
    const result = await provider.retrieve(perception);
    expect(result.docs[0]!.source).toBe("policy");
  });
});

// ── attestGrounding() ───────────────────────────────────────────────────────

describe("attestGrounding()", () => {
  it("produces a proof for each claim that matches a retrieved chunk", async () => {
    const { pool } = mockPool([
      row({
        id: "1",
        record_id: "rec-1",
        record_version: "v3",
        chunk_text: "The conductor coordinates the cortical orchestra.",
      }),
    ]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0]),
      modelId: "test-embed",
      tenantId: "t",
    });

    const docs = await provider.retrieve(perception);
    const proofs = await provider.attestGrounding(docs, [
      "conductor coordinates the cortical orchestra",
    ]);

    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.recordId).toBe("rec-1");
    expect(proofs[0]!.recordVersion).toBe("v3");
    expect(proofs[0]!.modelId).toBe("test-embed");
    expect(proofs[0]!.proofHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proofs[0]!.retrievedAt).toBe(docs.retrievedAt);
  });

  it("produces NO proof for a claim with no matching chunk", async () => {
    const { pool } = mockPool([
      row({ chunk_text: "Some retrieved fact about apples." }),
    ]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0]),
      modelId: "m",
      tenantId: "t",
    });

    const docs = await provider.retrieve(perception);
    const proofs = await provider.attestGrounding(docs, [
      "an entirely fabricated claim with no retrieval support",
    ]);

    expect(proofs).toHaveLength(0);
  });

  it("attaches a signature when a signer is configured", async () => {
    const { pool } = mockPool([row({ chunk_text: "alpha beta gamma." })]);
    const provider = createPgVectorGroundingProvider({
      pool,
      modelProvider: mockModelProvider([0]),
      modelId: "m",
      tenantId: "t",
      signer: { sign: (h) => `sig:${h.slice(0, 8)}` },
    });

    const docs = await provider.retrieve(perception);
    const proofs = await provider.attestGrounding(docs, ["alpha beta gamma"]);
    expect(proofs[0]!.signature).toBe(`sig:${proofs[0]!.proofHash.slice(0, 8)}`);
  });
});

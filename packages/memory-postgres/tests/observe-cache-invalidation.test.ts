/**
 * Observe — write-through cache invalidation, ordering invariant.
 *
 * The load-bearing assertion: Postgres `$transaction` commit timestamp
 * precedes the Redis `pipeline.del` timestamp. Reversing this opens a
 * rollback window where the snapshot survives data that doesn't exist.
 *
 * Also: a subsequent `recall()` returns the just-written turn (proves the
 * invalidation worked end-to-end).
 */

import { describe, expect, it } from "vitest";
import type { Perception, TurnOutcome } from "@claustrum/core";
import { createPostgresMemoryProvider } from "../src/postgres-memory-provider.js";
import { cacheKey } from "../src/cache-keys.js";
import {
  FakeAdjudicator,
  FakePrismaClient,
  FakeRedisClient,
} from "./mocks.js";

const PERCEPTION: Perception = {
  text: "i live in spain",
  channel: "whatsapp",
  locale: "es-ES",
  receivedAt: new Date().toISOString(),
};

function makeTurn(at: string = new Date().toISOString()): TurnOutcome {
  return {
    turnId: "turn-1",
    conversationId: "conv-1",
    perception: PERCEPTION,
    userText: "i live in spain",
    responseText: "noted, gracias",
    decisionKind: "EXECUTE",
    intentHash: "ih-abc",
    at,
  };
}

describe("observe — write-through ordering", () => {
  it("Postgres tx commits BEFORE Redis pipeline.del", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator: new FakeAdjudicator(),
    });

    // Seed the cache so the DEL has something to remove (proves it's invoked
    // even when there's nothing to clear is fine, but seeding makes the
    // effect observable).
    await redis.setex(cacheKey.snapshot("cust-1"), 60, "{}");

    await provider.observe("cust-1", makeTurn());

    expect(prisma.transactionCommittedAt.length).toBe(1);
    const txCommitAt = prisma.transactionCommittedAt[0]!;
    const pipelineDel = redis.calls.find((c) => c.op === "pipeline.del");
    expect(pipelineDel).toBeDefined();
    expect(pipelineDel!.at).toBeGreaterThan(txCommitAt);
  });

  it("invalidates snapshot, semantic, relational, episodicRecent", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator: new FakeAdjudicator(),
    });
    // Seed all four.
    await redis.setex(cacheKey.snapshot("cust-1"), 60, "snap");
    await redis.setex(cacheKey.semantic("cust-1"), 60, "sem");
    await redis.setex(cacheKey.relational("cust-1"), 60, "rel");
    await redis.setex(cacheKey.episodicRecent("cust-1"), 60, "epi");

    await provider.observe("cust-1", makeTurn());

    expect(redis.store.has(cacheKey.snapshot("cust-1"))).toBe(false);
    expect(redis.store.has(cacheKey.semantic("cust-1"))).toBe(false);
    expect(redis.store.has(cacheKey.relational("cust-1"))).toBe(false);
    expect(redis.store.has(cacheKey.episodicRecent("cust-1"))).toBe(false);
  });

  it("next recall reflects the new fact (cache busted, Postgres re-read)", async () => {
    let semanticRows: unknown[] = [];
    const prisma = new FakePrismaClient({
      episodicRows: [],
      semanticRows: [],
      proceduralRows: [],
      relationalRows: [],
    });
    const redis = new FakeRedisClient();
    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator: new FakeAdjudicator(),
    });

    // First recall — empty.
    const first = await provider.recall("cust-1", PERCEPTION);
    await new Promise((r) => setImmediate(r));
    expect(first.semantic.length).toBe(0);
    expect(redis.store.has(cacheKey.snapshot("cust-1"))).toBe(true);

    // Stand in a row that will materialize after observe(): the FakePrismaModel
    // returns from a responder if provided, but ours was seeded with an
    // empty []. We'll mutate the underlying responder by re-wiring the
    // model's rows array.
    semanticRows = [
      {
        key: "locale",
        value: "es-ES",
        confidence: 0.9,
        tags: ["perception"],
        recorded_at: new Date(),
      },
    ];
    // Replace the findManyResponder via direct override — the rows[] slot is
    // not what the responder is configured to use here, so we monkey-patch:
    const semModel = prisma.claustrum_memory_semantic;
    (semModel as unknown as { findMany: () => Promise<unknown[]> }).findMany =
      async () => semanticRows;

    await provider.observe("cust-1", makeTurn());

    // Cache should be empty now.
    expect(redis.store.has(cacheKey.snapshot("cust-1"))).toBe(false);

    const second = await provider.recall("cust-1", PERCEPTION);
    expect(second.semantic.length).toBe(1);
    expect(second.semantic[0]!.content).toContain("es-ES");
  });
});

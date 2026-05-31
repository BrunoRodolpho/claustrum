/**
 * ScalabilityReviewer-005 — episodic + relational memory retention pruning.
 *
 * Append-only growth tables get an opt-in `pruneOlderThan` (the analog of the
 * ibatexas RETENTION cleaner): bounded id-batches, dry-run, per-table fail-soft.
 * Semantic + procedural are intentionally untouched.
 */
import { describe, it, expect } from "vitest";
import { createPostgresMemoryProvider } from "../src/postgres-memory-provider.js";
import { FakePrismaClient, FakeRedisClient, FakeAdjudicator } from "./mocks.js";

function provider(prisma: FakePrismaClient) {
  return createPostgresMemoryProvider({
    prisma,
    redis: new FakeRedisClient(),
    adjudicator: new FakeAdjudicator(),
  });
}

const CUTOFF = new Date("2026-01-01T00:00:00.000Z");

describe("pruneOlderThan", () => {
  it("deletes episodic + relational rows in bounded id-batches", async () => {
    const prisma = new FakePrismaClient();
    prisma.claustrum_memory_episodic.rows.push(
      { id: "e1", recorded_at: new Date("2025-01-01") },
      { id: "e2", recorded_at: new Date("2025-06-01") },
    );
    prisma.claustrum_memory_relational.rows.push({
      id: "r1",
      observed_at: new Date("2025-03-01"),
    });

    const result = await provider(prisma).pruneOlderThan(CUTOFF);

    expect(result).toEqual({ episodic: 2, relational: 1, errors: [] });
    // Deleted by id-batch (never a blind table-wide deleteMany).
    const epiDelete = prisma.claustrum_memory_episodic.calls.find(
      (c) => c.op === "deleteMany",
    );
    expect(epiDelete?.args).toMatchObject({ where: { id: { in: ["e1", "e2"] } } });
    // And the find used the cutoff predicate.
    const epiFind = prisma.claustrum_memory_episodic.calls.find(
      (c) => c.op === "findMany",
    );
    expect(epiFind?.args).toMatchObject({ where: { recorded_at: { lt: CUTOFF } }, take: 1000 });
  });

  it("dry-run counts only — never deletes", async () => {
    const prisma = new FakePrismaClient();
    prisma.claustrum_memory_episodic.rows.push({ id: "e1" }, { id: "e2" }, { id: "e3" });
    prisma.claustrum_memory_relational.rows.push({ id: "r1" });

    const result = await provider(prisma).pruneOlderThan(CUTOFF, { dryRun: true });

    expect(result).toEqual({ episodic: 3, relational: 1, errors: [] });
    expect(
      prisma.claustrum_memory_episodic.calls.some((c) => c.op === "deleteMany"),
    ).toBe(false);
    expect(prisma.claustrum_memory_episodic.calls.some((c) => c.op === "count")).toBe(true);
  });

  it("is fail-soft per table — one table's failure does not abort the other", async () => {
    const prisma = new FakePrismaClient();
    prisma.claustrum_memory_relational.rows.push({ id: "r1" });
    // Episodic pruning throws; relational must still be pruned.
    (prisma.claustrum_memory_episodic as { findMany: unknown }).findMany =
      async () => {
        throw new Error("episodic boom");
      };

    const result = await provider(prisma).pruneOlderThan(CUTOFF);

    expect(result.relational).toBe(1);
    expect(result.episodic).toBe(0);
    expect(result.errors).toEqual([{ table: "episodic", message: "episodic boom" }]);
  });

  it("does NOT prune semantic or procedural memory", async () => {
    const prisma = new FakePrismaClient();
    prisma.claustrum_memory_semantic.rows.push({ id: "s1" });
    prisma.claustrum_memory_procedural.rows.push({ id: "p1" });

    await provider(prisma).pruneOlderThan(CUTOFF);

    expect(
      prisma.claustrum_memory_semantic.calls.some((c) => c.op === "deleteMany"),
    ).toBe(false);
    expect(
      prisma.claustrum_memory_procedural.calls.some((c) => c.op === "deleteMany"),
    ).toBe(false);
  });
});

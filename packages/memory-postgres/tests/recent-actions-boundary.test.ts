/**
 * Operational-memory boundary tripwire (CC-005).
 *
 * The `MemoryPort.recentActions` method has exactly one valid implementation
 * strategy: route through `Adjudicator.replayEnvelopesByCustomerId`. Any
 * adapter that issues raw SQL into the `intent_audit` table is wrong by
 * construction.
 *
 * This test asserts both halves:
 *   1. The adjudicator's replay method is called with the right args.
 *   2. No raw SQL invocation through the test session ever references
 *      "intent_audit".
 *
 * The mocks record every $queryRaw / $queryRawUnsafe call. The mock Prisma
 * also exposes a `rawSqlCalls` array — we walk it and pattern-match.
 *
 * Why this matters: the kernel owns the audit ledger. Allowing a raw read
 * here would create two writers (kernel + this adapter pretending to also
 * own it), and any schema migration in `@adjudicate/audit-postgres` would
 * silently break the runtime. The conformance suite enforces this at the
 * package boundary; this test catches it at the adapter level before
 * anything ships.
 */

import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@adjudicate/core";
import type { Perception, TurnOutcome } from "@claustrum/core";
import { createPostgresMemoryProvider } from "../src/postgres-memory-provider.js";
import {
  FakeAdjudicator,
  FakePrismaClient,
  FakeRedisClient,
} from "./mocks.js";

const PERCEPTION: Perception = {
  text: "test",
  channel: "test",
  receivedAt: new Date().toISOString(),
};

function makeTurn(): TurnOutcome {
  return {
    turnId: "t1",
    conversationId: "c1",
    perception: PERCEPTION,
    userText: "u",
    responseText: "r",
    at: new Date().toISOString(),
  };
}

const FAKE_RECORD: AuditRecord = {
  version: 4,
  intentHash: "ih-1",
  sessionId: "s-1",
  kind: "test.kind",
  principal: "user",
  taint: "TRUSTED",
  decision: { kind: "EXECUTE" },
  decisionBasis: [],
  envelope: {
    kind: "test.kind",
    payload: {},
    actor: { principal: "user", taint: "TRUSTED" },
  },
  recordedAt: new Date().toISOString(),
  durationMs: 1,
  auditHash: "ah-1",
} as unknown as AuditRecord;

describe("recentActions — operational-memory boundary (CC-005)", () => {
  it("delegates to Adjudicator.replayEnvelopesByCustomerId with the same args", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const adjudicator = new FakeAdjudicator();
    adjudicator.records = [FAKE_RECORD];

    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator,
    });

    const since = new Date(Date.now() - 60_000);
    const records = await provider.recentActions("cust-1", since);

    expect(adjudicator.replayCalls.length).toBe(1);
    expect(adjudicator.replayCalls[0]!.customerId).toBe("cust-1");
    expect(adjudicator.replayCalls[0]!.since).toBe(since);
    expect(records.length).toBe(1);
    expect(records[0]!.intentHash).toBe("ih-1");
  });

  it("no raw SQL during recentActions touches `intent_audit`", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const adjudicator = new FakeAdjudicator();
    adjudicator.records = [FAKE_RECORD];

    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator,
    });

    const sqlBefore = prisma.rawSqlCalls.length;
    await provider.recentActions("cust-1", new Date(0));
    const newCalls = prisma.rawSqlCalls.slice(sqlBefore);

    // No raw SQL at all is the strongest assertion — the call must be a
    // pure delegation, not a hybrid read.
    expect(newCalls.length).toBe(0);
  });

  it("no SQL anywhere in the provider mentions intent_audit (full transcript scan)", async () => {
    const prisma = new FakePrismaClient();
    const redis = new FakeRedisClient();
    const adjudicator = new FakeAdjudicator();

    const provider = createPostgresMemoryProvider({
      prisma,
      redis,
      adjudicator,
    });

    // Exercise every method that might tempt a future maintainer to reach
    // into the audit ledger. We don't care about return values; we care
    // about what SQL gets issued.
    await provider.recall("cust-1", PERCEPTION);
    await new Promise((r) => setImmediate(r));
    await provider.observe("cust-1", makeTurn());
    await provider.search("cust-1", { semantic: "hi" }, 5);
    await provider.recentActions("cust-1", new Date(0));

    const forbidden = prisma.rawSqlCalls.filter((c) =>
      c.sql.toLowerCase().includes("intent_audit"),
    );
    expect(forbidden).toEqual([]);
  });
});

/**
 * Test-double ring-buffer and clear() contract (MemoryReviewer-005/006).
 *
 * Verifies that:
 *  - RecordingTelemetrySink and InMemoryMemoryProvider cap their buffers at
 *    `maxBuffered` (oldest entries trimmed first).
 *  - clear() resets all buffers to empty.
 *  - Default behaviour is bounded (≤ 1 000 entries per buffer).
 *  - Passing `Infinity` restores unbounded behaviour.
 */

import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/test-doubles/in-memory-memory-provider.js";
import { RecordingTelemetrySink } from "../src/test-doubles/recording-telemetry-sink.js";
import type { LLMTrace, MemoryAccess, TurnRecord } from "../src/ports/telemetry.js";
import type { Perception } from "../src/ports/grounding.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const AT = new Date().toISOString();

function fakeTurnRecord(i: number): TurnRecord {
  return {
    turnId: `turn-${i}`,
    conversationId: `conv-${i}`,
    customerId: "cust",
    tenantId: "tenant",
    channel: "web",
    durationMs: i,
    at: AT,
  };
}

function fakeLLMTrace(i: number): LLMTrace {
  return {
    turnId: `turn-${i}`,
    model: "test-model",
    promptManifest: [],
    temperature: 0,
    inputTokens: i,
    outputTokens: i,
    completion: "",
    durationMs: i,
    at: AT,
  };
}

function fakeMemoryAccess(i: number): MemoryAccess {
  return {
    turnId: `turn-${i}`,
    customerId: "cust",
    kind: "recall",
    itemCount: i,
    durationMs: i,
    at: AT,
  };
}

function fakePerception(): Perception {
  return { text: "hello", channel: "web" as const, receivedAt: AT };
}

// ── RecordingTelemetrySink ────────────────────────────────────────────────────

describe("RecordingTelemetrySink", () => {
  it("caps turns at maxBuffered (ring: oldest trimmed)", async () => {
    const sink = new RecordingTelemetrySink({ maxBuffered: 3 });
    for (let i = 0; i < 5; i++) {
      await sink.emitTurn(fakeTurnRecord(i));
    }
    expect(sink.turns).toHaveLength(3);
    // Oldest entries (0,1) were trimmed; most recent (2,3,4) remain.
    expect(sink.turns[0]?.turnId).toBe("turn-2");
    expect(sink.turns[2]?.turnId).toBe("turn-4");
  });

  it("caps traces at maxBuffered", async () => {
    const sink = new RecordingTelemetrySink({ maxBuffered: 2 });
    for (let i = 0; i < 4; i++) {
      await sink.emitLLMTrace(fakeLLMTrace(i));
    }
    expect(sink.traces).toHaveLength(2);
    expect(sink.traces[0]?.turnId).toBe("turn-2");
  });

  it("caps memoryAccesses at maxBuffered", async () => {
    const sink = new RecordingTelemetrySink({ maxBuffered: 2 });
    for (let i = 0; i < 4; i++) {
      await sink.emitMemoryAccess(fakeMemoryAccess(i));
    }
    expect(sink.memoryAccesses).toHaveLength(2);
    expect(sink.memoryAccesses[0]?.turnId).toBe("turn-2");
  });

  it("clear() resets all three buffers", async () => {
    const sink = new RecordingTelemetrySink({ maxBuffered: 10 });
    await sink.emitTurn(fakeTurnRecord(0));
    await sink.emitLLMTrace(fakeLLMTrace(0));
    await sink.emitMemoryAccess(fakeMemoryAccess(0));

    sink.clear();

    expect(sink.turns).toHaveLength(0);
    expect(sink.traces).toHaveLength(0);
    expect(sink.memoryAccesses).toHaveLength(0);
  });

  it("default maxBuffered is 1 000 (bounded by default)", async () => {
    const sink = new RecordingTelemetrySink();
    const over = 1_001;
    for (let i = 0; i < over; i++) {
      await sink.emitTurn(fakeTurnRecord(i));
    }
    expect(sink.turns).toHaveLength(1_000);
    // Oldest (turn-0) was trimmed.
    expect(sink.turns[0]?.turnId).toBe("turn-1");
  });

  it("Infinity restores unbounded behaviour", async () => {
    const sink = new RecordingTelemetrySink({ maxBuffered: Infinity });
    for (let i = 0; i < 5; i++) {
      await sink.emitTurn(fakeTurnRecord(i));
    }
    expect(sink.turns).toHaveLength(5);
  });
});

// ── InMemoryMemoryProvider ────────────────────────────────────────────────────

describe("InMemoryMemoryProvider", () => {
  it("caps observed at maxBuffered (ring: oldest trimmed)", async () => {
    const provider = new InMemoryMemoryProvider({ maxBuffered: 3 });
    for (let i = 0; i < 5; i++) {
      await provider.observe("cust", {
        turnId: `turn-${i}`,
        conversationId: `conv-${i}`,
        userText: `msg-${i}`,
        at: AT,
        decisionKind: "EXECUTE",
      });
    }
    expect(provider.observed).toHaveLength(3);
    expect(provider.observed[0]?.userText).toBe("msg-2");
    expect(provider.observed[2]?.userText).toBe("msg-4");
  });

  it("caps recalls at maxBuffered", async () => {
    const provider = new InMemoryMemoryProvider({ maxBuffered: 2 });
    const perception = fakePerception();
    for (let i = 0; i < 4; i++) {
      await provider.recall(`cust-${i}`, perception);
    }
    expect(provider.recalls).toHaveLength(2);
    expect(provider.recalls[0]?.customerId).toBe("cust-2");
  });

  it("clear() resets observed and recalls", async () => {
    const provider = new InMemoryMemoryProvider({ maxBuffered: 10 });
    await provider.observe("cust", {
      turnId: "turn-0",
      conversationId: "conv-0",
      userText: "hello",
      at: AT,
      decisionKind: "EXECUTE",
    });
    await provider.recall("cust", fakePerception());

    provider.clear();

    expect(provider.observed).toHaveLength(0);
    expect(provider.recalls).toHaveLength(0);
  });

  it("default maxBuffered is 1 000 (bounded by default)", async () => {
    const provider = new InMemoryMemoryProvider();
    const over = 1_001;
    for (let i = 0; i < over; i++) {
      await provider.observe("cust", {
        turnId: `turn-${i}`,
        conversationId: `conv-${i}`,
        userText: `msg-${i}`,
        at: AT,
        decisionKind: "EXECUTE",
      });
    }
    expect(provider.observed).toHaveLength(1_000);
    expect(provider.observed[0]?.userText).toBe("msg-1");
  });

  it("Infinity restores unbounded behaviour", async () => {
    const provider = new InMemoryMemoryProvider({ maxBuffered: Infinity });
    for (let i = 0; i < 5; i++) {
      await provider.observe("cust", {
        turnId: `turn-${i}`,
        conversationId: `conv-${i}`,
        userText: `msg-${i}`,
        at: AT,
        decisionKind: "EXECUTE",
      });
    }
    expect(provider.observed).toHaveLength(5);
  });
});

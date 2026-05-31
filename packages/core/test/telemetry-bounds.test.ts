/**
 * APIReviewer-015 — telemetry schema version + LLMTrace size budget.
 */
import { describe, it, expect } from "vitest";
import type { LLMTrace } from "../src/index.js";
import { TELEMETRY_SCHEMA_VERSION, boundLLMTrace } from "../src/index.js";

function trace(overrides: Partial<LLMTrace> = {}): LLMTrace {
  return {
    turnId: "t-1",
    promptManifest: ["frag:a"],
    model: "claude",
    temperature: 0,
    inputTokens: 10,
    outputTokens: 20,
    completion: "x".repeat(10000),
    logprobs: [0.1, 0.2, 0.3],
    toolCallsRaw: [{ a: 1 }, { b: 2 }],
    durationMs: 5,
    at: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("boundLLMTrace", () => {
  it("stamps the current schema version", () => {
    expect(boundLLMTrace(trace()).schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
  });

  it("truncates completion to the budget (default 4096)", () => {
    expect(boundLLMTrace(trace()).completion).toHaveLength(4096);
    expect(boundLLMTrace(trace(), { maxCompletionChars: 100 }).completion).toHaveLength(100);
  });

  it("leaves a short completion untouched", () => {
    const t = trace({ completion: "ok" });
    expect(boundLLMTrace(t).completion).toBe("ok");
  });

  it("drops logprobs by default (heaviest, opt-in field)", () => {
    expect(boundLLMTrace(trace()).logprobs).toBeUndefined();
  });

  it("retains logprobs up to maxLogprobs when requested", () => {
    expect(boundLLMTrace(trace(), { maxLogprobs: 2 }).logprobs).toEqual([0.1, 0.2]);
  });

  it("keeps toolCallsRaw by default, caps when requested", () => {
    expect(boundLLMTrace(trace()).toolCallsRaw).toHaveLength(2);
    expect(boundLLMTrace(trace(), { maxToolCalls: 1 }).toolCallsRaw).toHaveLength(1);
  });

  it("is pure — does not mutate the input", () => {
    const t = trace();
    const before = t.completion.length;
    boundLLMTrace(t, { maxCompletionChars: 10 });
    expect(t.completion.length).toBe(before);
    expect(t.logprobs).toEqual([0.1, 0.2, 0.3]);
  });
});

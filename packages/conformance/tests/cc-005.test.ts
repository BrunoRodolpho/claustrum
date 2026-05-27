/**
 * CC-005 — memory-recent-actions-via-api.
 */

import type { AuditRecord } from "@adjudicate/core";
import type { MemoryPort } from "@claustrum/core";
import { describe, expect, it } from "vitest";
import { memoryRecentActionsViaApiCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

describe("CC-005 memory-recent-actions-via-api", () => {
  it("passes vacuously for the in-memory test-double (returns empty without consulting kernel)", async () => {
    const { conductor } = makeTestConductor();
    const result = await memoryRecentActionsViaApiCheck.run(conductor, {});
    expect(result.passed).toBe(true);
    expect(result.id).toBe("CC-005");
    expect(result.details ?? "").toContain("in-memory stub");
  });

  it("passes when memory.recentActions calls Adjudicator.replayEnvelopesByCustomerId", async () => {
    const { conductor } = makeTestConductor();
    // Patch the memory port to route through the adjudicator.
    const goodMemory: MemoryPort = {
      async recall(): Promise<{
        customerId: string;
        episodic: never[];
        semantic: never[];
        procedural: never[];
        relational: never[];
        assembledAt: string;
      }> {
        return {
          customerId: "x",
          episodic: [],
          semantic: [],
          procedural: [],
          relational: [],
          assembledAt: "2026-05-18T00:00:00.000Z",
        };
      },
      async observe(): Promise<void> {
        /* no-op */
      },
      async search(): Promise<never[]> {
        return [];
      },
      async recentActions(customerId: string, since: Date): Promise<ReadonlyArray<AuditRecord>> {
        return conductor.adjudicator.replayEnvelopesByCustomerId(customerId, since);
      },
    };
    (conductor as unknown as { memory: MemoryPort }).memory = goodMemory;
    const result = await memoryRecentActionsViaApiCheck.run(conductor, {});
    expect(result.passed).toBe(true);
    expect(result.details ?? "").toContain("invoked");
  });

  it("fails when memory.recentActions returns non-empty without calling Adjudicator", async () => {
    const { conductor } = makeTestConductor();
    const badMemory: MemoryPort = {
      async recall(): Promise<{
        customerId: string;
        episodic: never[];
        semantic: never[];
        procedural: never[];
        relational: never[];
        assembledAt: string;
      }> {
        return {
          customerId: "x",
          episodic: [],
          semantic: [],
          procedural: [],
          relational: [],
          assembledAt: "2026-05-18T00:00:00.000Z",
        };
      },
      async observe(): Promise<void> {
        /* no-op */
      },
      async search(): Promise<never[]> {
        return [];
      },
      async recentActions(): Promise<ReadonlyArray<AuditRecord>> {
        // Boundary violation: produce records without going through the
        // Adjudicator. This is the regression CC-005 catches.
        return [
          {
            envelope: {} as never,
            decision: { kind: "EXECUTE", basis: [] },
            recordedAt: "2026-05-18T00:00:00.000Z",
            auditHash: "deadbeef",
          } as unknown as AuditRecord,
        ];
      },
    };
    (conductor as unknown as { memory: MemoryPort }).memory = badMemory;
    const result = await memoryRecentActionsViaApiCheck.run(conductor, {});
    expect(result.passed).toBe(false);
    expect(result.details ?? "").toContain("boundary violation");
  });
});

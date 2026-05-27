/**
 * PROPERTY: every envelope produced by the planner has actor.principal set.
 *
 * The kernel's `isIntentEnvelope` check rejects envelopes without
 * actor.principal — adjudicate refuses with `schema_version_unsupported`.
 * The runtime guarantees every planner output respects this.
 *
 * Iterations: 200 (>= 100 as required).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { handleTurn, type PlannerPort, type ResponderPort } from "../../src/index.js";
import {
  buildHarness,
  buildInbound,
  buildTestEnvelope,
  makeTool,
} from "./harness.js";

const ITERATIONS = 200;

describe("PROPERTY: planner envelopes always carry actor.principal", () => {
  it(`holds for at least ${ITERATIONS} random inputs`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("llm" as const, "user" as const, "system" as const),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (principal, text) => {
          iterations += 1;
          const planner: PlannerPort = {
            async propose() {
              return {
                envelopes: [
                  buildTestEnvelope({ kind: "test.kind", principal }),
                ],
              };
            },
          };
          const responder: ResponderPort = {
            async respond() {
              return { text: "ok" };
            },
          };
          const noopTool = makeTool({
            id: "noop.tool",
            capability: "test.kind",
            intentKind: "test.kind",
            execute: async () => ({ ok: true }),
          });
          const { capsule } = await buildHarness({
            planner,
            responder,
            tools: [noopTool],
          });
          const result = await handleTurn(capsule, buildInbound(text));
          for (const envelope of result.plan.envelopes) {
            if (typeof envelope.actor.principal !== "string") return false;
            if (envelope.actor.principal.length === 0) return false;
          }
          return true;
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});

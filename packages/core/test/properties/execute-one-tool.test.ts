/**
 * PROPERTY: every EXECUTE decision triggers exactly one tool invocation.
 *
 * Per Hard Rule #7 + conformance CC-002. The dispatcher MUST resolve
 * the capability + invoke the tool once. Re-invocation indicates a
 * dispatch bug.
 *
 * Iterations: 200.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  handleTurn,
  type PlannerPort,
  type ResponderPort,
} from "../../src/index.js";
import {
  buildHarness,
  buildInbound,
  buildTestEnvelope,
  makeTool,
} from "./harness.js";

const ITERATIONS = 200;

describe("PROPERTY: EXECUTE -> exactly one tool invocation", () => {
  it(`holds for at least ${ITERATIONS} random inputs`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (text) => {
          iterations += 1;
          let invocationCount = 0;
          const tool = makeTool({
            id: "test.tool",
            capability: "test.cap",
            intentKind: "test.cap",
            execute: async () => {
              invocationCount += 1;
              return { ok: true };
            },
          });
          const planner: PlannerPort = {
            async propose() {
              return {
                envelopes: [
                  buildTestEnvelope({ kind: "test.cap", principal: "llm" }),
                ],
              };
            },
          };
          const responder: ResponderPort = {
            async respond() {
              return { text: "done" };
            },
          };
          const { capsule } = await buildHarness({
            planner,
            responder,
            tools: [tool],
          });
          const result = await handleTurn(capsule, buildInbound(text));
          if (result.decision.kind !== "EXECUTE") return true; // vacuously
          if (invocationCount !== 1) return false;
          return true;
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});

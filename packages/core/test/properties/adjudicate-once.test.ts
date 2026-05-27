/**
 * PROPERTY: adjudicate is called exactly once per turn.
 *
 * Per Hard Rule #3 + the cognitive-loop invariants. handleTurn either
 * calls `capsule.adjudicate(envelope)` once (single-envelope plan) OR
 * `capsule.adjudicatePlan(envelopes)` once (multi-envelope plan). The
 * sum of (`adjudicateCalls` + `adjudicatePlanCalls`) is always 1.
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

describe("PROPERTY: adjudicate called exactly once per turn", () => {
  it(`holds for at least ${ITERATIONS} random inputs`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (envelopeCount, text) => {
          iterations += 1;
          const planner: PlannerPort = {
            async propose() {
              const envelopes = Array.from(
                { length: envelopeCount },
                (_, i) =>
                  buildTestEnvelope({
                    kind: "test.kind",
                    principal: "llm",
                    nonce: `nonce-${i}-${Math.random()}`,
                  }),
              );
              return { envelopes };
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
          const { capsule, adjudicator } = await buildHarness({
            planner,
            responder,
            tools: [noopTool],
          });
          await handleTurn(capsule, buildInbound(text));
          const totalCalls =
            adjudicator.adjudicateCalls.length +
            adjudicator.adjudicatePlanCalls.length;
          if (totalCalls !== 1) return false;
          // Routing: 1 envelope -> adjudicate; otherwise -> adjudicatePlan.
          if (envelopeCount === 1) {
            return (
              adjudicator.adjudicateCalls.length === 1 &&
              adjudicator.adjudicatePlanCalls.length === 0
            );
          }
          return (
            adjudicator.adjudicatePlanCalls.length === 1 &&
            adjudicator.adjudicateCalls.length === 0
          );
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});

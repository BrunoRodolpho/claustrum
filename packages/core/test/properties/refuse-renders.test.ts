/**
 * PROPERTY: REFUSE always renders to non-empty user-facing text.
 *
 * Per Hard Rule #7 + conformance CC-004. The Explainer is the SOLE
 * surface that turns a Refusal into prose for the user. An empty
 * render means the user sees a blank message — a silent failure mode
 * we explicitly forbid.
 *
 * Iterations: 150.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  handleTurn,
  type ExplainerPort,
  type PlannerPort,
  type ResponderPort,
} from "../../src/index.js";
import {
  buildHarness,
  buildInbound,
  buildTestEnvelope,
} from "./harness.js";

const ITERATIONS = 150;

describe("PROPERTY: REFUSE always renders to non-empty text", () => {
  it(`holds for at least ${ITERATIONS} random refusals`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (text, refusalCode) => {
          iterations += 1;
          // StubAdjudicator refuses on kind === "danger"; planner emits
          // that kind so we reliably hit a REFUSE branch.
          const planner: PlannerPort = {
            async propose() {
              return {
                envelopes: [
                  buildTestEnvelope({
                    kind: "danger",
                    principal: "llm",
                    nonce: `n-${refusalCode}`,
                  }),
                ],
              };
            },
          };
          const responder: ResponderPort = {
            async respond({ decision }) {
              if (decision.kind === "REFUSE") {
                return { text: decision.refusal.userFacing };
              }
              return { text: "ok" };
            },
          };
          const explainer: ExplainerPort = {
            render(refusal) {
              return `[${refusal.kind}] ${refusal.userFacing}`;
            },
          };
          const { capsule } = await buildHarness({
            planner,
            responder,
            explainer,
          });
          const result = await handleTurn(capsule, buildInbound(text));
          if (result.decision.kind !== "REFUSE") return true; // vacuously
          if (result.acted.kind !== "refused") return false;
          if (typeof result.acted.userText !== "string") return false;
          if (result.acted.userText.length === 0) return false;
          return true;
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});

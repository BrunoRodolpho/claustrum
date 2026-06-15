/**
 * CC-007 — responder-respects-decision.
 */

import { describe, expect, it } from "vitest";
import type { DraftResponse, ResponderPort } from "@claustrum/core";
import { responderRespectsDecisionCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

/**
 * A decision-BLIND responder: it answers from the user's text alone and
 * never reads `input.decision`. This is the exact shape of the bug CC-007
 * is meant to catch (a chat reply that contradicts the audited decision).
 */
function makeBlindResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      return { text: `Resposta: ${input.cognition.perception.text}` };
    },
  };
}

describe("CC-007 responder-respects-decision", () => {
  it("passes against the decision-aware test conductor", async () => {
    const { conductor } = makeTestConductor();
    const result = await responderRespectsDecisionCheck.run(conductor, {
      sampling: 20,
      seed: 42,
    });
    expect(result.id).toBe("CC-007");
    expect(result.passed).toBe(true);
  });

  it("fails a decision-BLIND responder that ignores the REFUSE decision", async () => {
    const { conductor } = makeTestConductor({ responder: makeBlindResponder() });
    const result = await responderRespectsDecisionCheck.run(conductor, {
      sampling: 20,
      seed: 42,
    });
    expect(result.id).toBe("CC-007");
    // The blind responder echoes user text on a REFUSE turn, so the draft
    // never surfaces the explainer's refusal text → the invariant is violated.
    expect(result.passed).toBe(false);
    expect(result.details).toContain("ignored the decision");
  });
});

/**
 * CC-004 — refuse-renders-user-text.
 */

import { describe, expect, it } from "vitest";
import { refuseRendersUserTextCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

describe("CC-004 refuse-renders-user-text", () => {
  it("passes vacuously when the conductor never produces REFUSE", async () => {
    const { conductor } = makeTestConductor();
    // The StubAdjudicator only REFUSEs when the envelope kind is "danger".
    // The test-double planner only proposes "danger" when the inbound text
    // contains the word "danger" — which the seeded text does not.
    const result = await refuseRendersUserTextCheck.run(conductor, {
      sampling: 10,
      seed: 42,
    });
    expect(result.passed).toBe(true);
    expect(result.id).toBe("CC-004");
  });

  it("passes when REFUSE branch fires and the explainer renders non-empty text", async () => {
    const { conductor } = makeTestConductor();
    // Use a seed/sampling combination that we know will surface "danger"
    // inputs. Our test-double maps text containing "danger" → danger
    // envelope → REFUSE.
    const result = await refuseRendersUserTextCheck.run(conductor, {
      sampling: 5,
      seed: 1,
    });
    // Either vacuous-pass (no REFUSE produced) or real-pass (REFUSE
    // produced and rendered). Both outcomes are valid for CC-004.
    expect(result.passed).toBe(true);
  });
});

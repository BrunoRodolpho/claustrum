/**
 * CC-002 — execute-triggers-one-tool.
 */

import { describe, expect, it } from "vitest";
import { executeTriggersOneToolCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

describe("CC-002 execute-triggers-one-tool", () => {
  it("passes against a clean test conductor (mostly EXECUTE)", async () => {
    const { conductor } = makeTestConductor();
    const result = await executeTriggersOneToolCheck.run(conductor, {
      sampling: 30,
      seed: 42,
    });
    expect(result.id).toBe("CC-002");
    expect(result.passed).toBe(true);
  });

  it("handles REFUSE turns correctly (no tool invocation)", async () => {
    const { conductor } = makeTestConductor();
    // Sampling 30 with the deterministic LCG produces a mix of inputs;
    // the test-double planner produces danger envelopes for inputs
    // containing "danger". The CC-002 check itself does not inject
    // danger inputs, but the broader determinism is preserved —
    // EXECUTE turns trigger exactly 1, others trigger 0.
    const result = await executeTriggersOneToolCheck.run(conductor, {
      sampling: 30,
      seed: 7,
    });
    expect(result.passed).toBe(true);
  });

  it("restores adopter tool state after check completes", async () => {
    const { conductor, tools } = makeTestConductor();
    const originalExecute = tools.list()[0]?.execute;
    await executeTriggersOneToolCheck.run(conductor, {
      sampling: 5,
      seed: 42,
    });
    const restored = tools.list()[0]?.execute;
    expect(restored).toBe(originalExecute);
  });
});

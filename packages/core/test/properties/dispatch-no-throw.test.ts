/**
 * PROPERTY: dispatch is total — no Decision variant throws out of the turn.
 *
 * RC-R1 (consolidated-dispatch-throws): a kernel-approved Decision the runtime
 * cannot honor (unregistered capability, a tool that rejects, an explainer
 * template miss) must NOT crash handleTurn — the user still gets a reply,
 * OBSERVE still runs, and the turn yields a typed failure rather than an
 * unhandled rejection that leaks internal error text.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decisionRefuse, refuse } from "@adjudicate/core";
import {
  handleTurn,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type ExplainerPort,
} from "../../src/index.js";
import { dispatchDecision } from "../../src/execution/dispatch.js";
import {
  buildHarness,
  buildInbound,
  buildTestEnvelope,
  makeTool,
} from "./harness.js";

const ITERATIONS = 100;

const passResponder: ResponderPort = {
  async respond() {
    return { text: "ok" };
  },
};

describe("PROPERTY: dispatch never throws — handleTurn survives port failures (RC-R1)", () => {
  it(`EXECUTE for an unregistered capability degrades to failed, no reject (${ITERATIONS} runs)`, async () => {
    let iterations = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }),
        async (raw) => {
          iterations += 1;
          const kind = `unreg.${raw.replace(/[^a-z0-9]/gi, "")}.x`;
          const planner: PlannerPort = {
            async propose() {
              return { envelopes: [buildTestEnvelope({ kind, principal: "llm" })] };
            },
          };
          // No tools registered -> resolveTool throws on this capability.
          const { capsule } = await buildHarness({
            planner,
            responder: passResponder,
            tools: [],
          });
          const result = await handleTurn(capsule, buildInbound("hi"));
          if (result.decision.kind !== "EXECUTE") return true; // vacuous
          return (
            result.acted.kind === "failed" &&
            result.acted.code === "tool_unresolved" &&
            result.response.meta?.failed === true
          );
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });

  it("EXECUTE where the tool rejects degrades to failed (tool_threw), no reject", async () => {
    const kind = "boom.cap";
    const tool = makeTool({
      id: "boom.tool",
      capability: kind,
      intentKind: kind,
      execute: async () => {
        throw new Error("network 5xx mid-refund");
      },
    });
    const planner: PlannerPort = {
      async propose() {
        return { envelopes: [buildTestEnvelope({ kind, principal: "llm" })] };
      },
    };
    const { capsule } = await buildHarness({
      planner,
      responder: passResponder,
      tools: [tool],
    });
    const result = await handleTurn(capsule, buildInbound("hi"));
    if (result.decision.kind !== "EXECUTE") return;
    expect(result.acted.kind).toBe("failed");
    if (result.acted.kind === "failed") {
      expect(result.acted.code).toBe("tool_threw");
      expect(result.acted.message).toContain("network 5xx");
    }
    expect(result.response.meta?.failed).toBe(true);
  });

  it("REFUSE falls back to safe non-empty text when the explainer throws (no reject)", async () => {
    const throwingExplainer: ExplainerPort = {
      render() {
        throw new Error("explain template miss");
      },
    };
    const { capsule } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      explainer: throwingExplainer,
    });
    const refuseDecision = decisionRefuse(
      refuse("BUSINESS_RULE", "policy_x", "no", "operator detail"),
      [],
    );
    const emptyPlan: Plan = { envelopes: [] };
    const acted = await dispatchDecision(refuseDecision, emptyPlan, capsule);
    expect(acted.kind).toBe("refused");
    if (acted.kind === "refused") {
      expect(acted.userText.length).toBeGreaterThan(0);
      expect(acted.code).toBe("policy_x");
    }
  });
});

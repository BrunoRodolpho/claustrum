/**
 * LogicReviewer-003 — multi-envelope dispatch.
 *
 * `adjudicatePlan` is transactional (kill-all-or-execute-all): a plan-level EXECUTE
 * means every envelope was approved. Dispatch must therefore run EVERY envelope's
 * tool, not just `envelopes[0]`. The single-envelope path stays byte-equivalent
 * (`kind: "executed"`); a multi-envelope EXECUTE yields `kind: "executed_plan"`
 * carrying one execution per envelope. A tool that throws mid-plan still degrades to
 * `failed` (the dispatch-no-throw guarantee is preserved).
 */

import { describe, it, expect } from "vitest";
import { decisionExecute } from "@adjudicate/core";
import type { Plan, ResponderPort } from "../../src/index.js";
import { dispatchDecision } from "../../src/execution/dispatch.js";
import { buildHarness, buildTestEnvelope, makeTool } from "./harness.js";

const passResponder: ResponderPort = {
  async respond() {
    return { text: "ok" };
  },
};

describe("dispatch — multi-envelope plan (LogicReviewer-003)", () => {
  it("dispatches EVERY envelope of a multi-envelope EXECUTE plan, in order", async () => {
    const calls: string[] = [];
    const toolA = makeTool({
      id: "a.tool",
      capability: "a.cap",
      intentKind: "a.cap",
      execute: async () => {
        calls.push("a");
        return "ra";
      },
    });
    const toolB = makeTool({
      id: "b.tool",
      capability: "b.cap",
      intentKind: "b.cap",
      execute: async () => {
        calls.push("b");
        return "rb";
      },
    });
    const { capsule } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      tools: [toolA, toolB],
    });
    const plan: Plan = {
      envelopes: [
        buildTestEnvelope({ kind: "a.cap" }),
        buildTestEnvelope({ kind: "b.cap" }),
      ],
    };

    const acted = await dispatchDecision(decisionExecute([]), plan, capsule);

    expect(acted.kind).toBe("executed_plan");
    if (acted.kind === "executed_plan") {
      expect(acted.executions.map((e) => e.toolId)).toEqual(["a.tool", "b.tool"]);
      expect(acted.executions.map((e) => e.result)).toEqual(["ra", "rb"]);
    }
    // Both tools ran, left-to-right — not just envelopes[0].
    expect(calls).toEqual(["a", "b"]);
  });

  it("single-envelope EXECUTE is byte-equivalent (kind: executed)", async () => {
    const toolA = makeTool({
      id: "a.tool",
      capability: "a.cap",
      intentKind: "a.cap",
      execute: async () => "ra",
    });
    const { capsule } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      tools: [toolA],
    });
    const plan: Plan = { envelopes: [buildTestEnvelope({ kind: "a.cap" })] };

    const acted = await dispatchDecision(decisionExecute([]), plan, capsule);

    expect(acted.kind).toBe("executed");
    if (acted.kind === "executed") {
      expect(acted.toolId).toBe("a.tool");
      expect(acted.result).toBe("ra");
    }
  });

  it("a tool that throws mid-plan degrades to failed (no-throw preserved)", async () => {
    const toolA = makeTool({
      id: "a.tool",
      capability: "a.cap",
      intentKind: "a.cap",
      execute: async () => "ra",
    });
    const toolB = makeTool({
      id: "b.tool",
      capability: "b.cap",
      intentKind: "b.cap",
      execute: async () => {
        throw new Error("boom mid-plan");
      },
    });
    const { capsule } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      tools: [toolA, toolB],
    });
    const plan: Plan = {
      envelopes: [
        buildTestEnvelope({ kind: "a.cap" }),
        buildTestEnvelope({ kind: "b.cap" }),
      ],
    };

    const acted = await dispatchDecision(decisionExecute([]), plan, capsule);

    expect(acted.kind).toBe("failed");
    if (acted.kind === "failed") {
      expect(acted.code).toBe("tool_threw");
      expect(acted.message).toContain("boom mid-plan");
    }
  });
});

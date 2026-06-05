/**
 * TypeReviewer-004 — capability resolution is validated, never a blind cast.
 *
 * `inferCapability` used to do `envelope.kind as CapabilityId` — minting the
 * `CapabilityId` brand over an arbitrary string with zero validation. The fix
 * routes the kind through `asCapability` (shape) + `ToolRegistry.hasCapability`
 * (membership) before branding. These tests pin:
 *
 *  - known kind  -> resolves + executes (behavior unchanged for valid input)
 *  - unknown kind -> fails closed (`tool_unresolved`), tool NEVER invoked
 *  - malformed kind ("" / whitespace) -> fails closed, never branded
 *  - the `asCapability` guard + `hasCapability` membership in isolation
 */

import { describe, it, expect } from "vitest";
import { decisionExecute, decisionRewrite } from "@adjudicate/core";
import {
  asCapability,
  isWellFormedCapability,
  createToolRegistry,
  type Plan,
} from "../src/index.js";
import { dispatchDecision } from "../src/execution/dispatch.js";
import {
  buildHarness,
  buildTestEnvelope,
  makeTool,
} from "./properties/harness.js";

const passResponder = { async respond() { return { text: "ok" }; } };
const passPlanner = { async propose() { return { envelopes: [] }; } };

describe("asCapability / isWellFormedCapability (TypeReviewer-004)", () => {
  it("brands a well-formed string", () => {
    const cap = asCapability("payment.refund");
    expect(cap).toBe("payment.refund");
  });

  it("rejects empty / whitespace-only / non-string", () => {
    expect(asCapability("")).toBeUndefined();
    expect(asCapability("   ")).toBeUndefined();
    expect(asCapability(undefined)).toBeUndefined();
    expect(asCapability(null)).toBeUndefined();
    expect(asCapability(42)).toBeUndefined();
    expect(isWellFormedCapability("x")).toBe(true);
    expect(isWellFormedCapability("")).toBe(false);
  });
});

describe("ToolRegistry.hasCapability (TypeReviewer-004)", () => {
  it("true only for a registered capability, false otherwise", () => {
    const reg = createToolRegistry();
    expect(reg.hasCapability("nope.cap")).toBe(false);
    reg.register(
      makeTool({
        id: "t.1",
        capability: "known.cap",
        intentKind: "known.cap",
        execute: async () => ({ ok: true }),
      }),
    );
    expect(reg.hasCapability("known.cap")).toBe(true);
    expect(reg.hasCapability("unknown.cap")).toBe(false);
    // Membership is shape-agnostic but still fails closed on junk.
    expect(reg.hasCapability("")).toBe(false);
  });
});

describe("dispatch EXECUTE — capability validated before brand (TypeReviewer-004)", () => {
  it("known kind resolves and invokes the tool exactly once", async () => {
    let calls = 0;
    const tool = makeTool({
      id: "refund.tool",
      capability: "payment.refund",
      intentKind: "payment.refund",
      execute: async () => {
        calls += 1;
        return { refunded: true };
      },
    });
    const { capsule } = await buildHarness({
      planner: passPlanner,
      responder: passResponder,
      tools: [tool],
    });
    const plan: Plan = {
      envelopes: [buildTestEnvelope({ kind: "payment.refund" })],
    };
    const result = await dispatchDecision(decisionExecute([]), plan, capsule);
    expect(result.kind).toBe("executed");
    if (result.kind === "executed") {
      expect(result.toolId).toBe("refund.tool");
      expect(result.result).toEqual({ refunded: true });
    }
    expect(calls).toBe(1);
  });

  it("unknown kind fails closed as tool_unresolved and never brands/invokes", async () => {
    let calls = 0;
    const tool = makeTool({
      id: "refund.tool",
      capability: "payment.refund",
      intentKind: "payment.refund",
      execute: async () => {
        calls += 1;
        return { refunded: true };
      },
    });
    const { capsule } = await buildHarness({
      planner: passPlanner,
      responder: passResponder,
      tools: [tool],
    });
    // A kind the registry has never heard of — must NOT be branded into a
    // CapabilityId and pushed at resolveTool; dispatch fails closed instead.
    const plan: Plan = {
      envelopes: [buildTestEnvelope({ kind: "totally.unregistered.kind" })],
    };
    const result = await dispatchDecision(decisionExecute([]), plan, capsule);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("tool_unresolved");
      expect(result.phase).toBe("EXECUTE");
      expect(result.message).toContain("totally.unregistered.kind");
    }
    expect(calls).toBe(0);
  });

  it("malformed (empty) kind fails closed without branding garbage", async () => {
    const { capsule } = await buildHarness({
      planner: passPlanner,
      responder: passResponder,
      tools: [],
    });
    const plan: Plan = {
      envelopes: [buildTestEnvelope({ kind: "" })],
    };
    const result = await dispatchDecision(decisionExecute([]), plan, capsule);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("tool_unresolved");
    }
  });
});

describe("dispatch REWRITE — capability validated before brand (TypeReviewer-004)", () => {
  it("unknown rewritten kind fails closed as tool_unresolved (REWRITE phase)", async () => {
    const { capsule } = await buildHarness({
      planner: passPlanner,
      responder: passResponder,
      tools: [],
    });
    const rewritten = buildTestEnvelope({ kind: "unregistered.rewrite.kind" });
    const plan: Plan = { envelopes: [] };
    const result = await dispatchDecision(
      decisionRewrite(rewritten, "policy normalized the payload", []),
      plan,
      capsule,
    );
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.code).toBe("tool_unresolved");
      expect(result.phase).toBe("REWRITE");
    }
  });
});

/**
 * CC-001 — tool-capability-indirection.
 */

import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  type CapabilityId,
  type IntentKind,
  type ToolDefinition,
} from "@claustrum/core";
import { toolCapabilityIndirectionCheck } from "../src/index.js";
import { makeTestConductor } from "./make-conductor.js";

describe("CC-001 tool-capability-indirection", () => {
  it("passes against a clean test conductor", async () => {
    const { conductor } = makeTestConductor();
    const result = await toolCapabilityIndirectionCheck.run(conductor, {});
    expect(result.passed).toBe(true);
    expect(result.id).toBe("CC-001");
  });

  it("passes vacuously when no tools are registered", async () => {
    const { conductor } = makeTestConductor({ tools: null });
    const result = await toolCapabilityIndirectionCheck.run(conductor, {});
    expect(result.passed).toBe(true);
    expect(result.details ?? "").toContain("No tools registered");
  });

  it("fails when an internal tool id appears as a capability", async () => {
    // Construct two tools: one registered under capability "stripe.refund"
    // whose id is "stripe.refund.v2", and another registered under
    // capability "stripe.refund.v2" — the second registration leaks the
    // first one's internal id into the capability surface.
    const cap = "stripe.refund" as CapabilityId;
    const leakedAsCap = "stripe.refund.v2" as CapabilityId;
    const kind = "payment.refund" as IntentKind;
    const tool1: ToolDefinition = {
      id: "stripe.refund.v2",
      capability: cap,
      description: "real refund tool",
      inputSchema: {},
      outputSchema: {},
      intentKind: kind,
      riskLevel: "high",
      async execute(): Promise<unknown> {
        return {};
      },
    };
    const tool2: ToolDefinition = {
      id: "leaked.tool",
      capability: leakedAsCap,
      description: "leaks v2 id as capability",
      inputSchema: {},
      outputSchema: {},
      intentKind: kind,
      riskLevel: "high",
      async execute(): Promise<unknown> {
        return {};
      },
    };
    const reg = createToolRegistry();
    reg.register(tool1);
    reg.register(tool2);

    const { conductor } = makeTestConductor({ tools: reg });
    const result = await toolCapabilityIndirectionCheck.run(conductor, {});
    expect(result.passed).toBe(false);
    expect(result.details ?? "").toContain("stripe.refund.v2");
  });
});

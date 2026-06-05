/**
 * PerformanceReviewer-002 — `resolveCapabilities` caches the ctx-INDEPENDENT
 * base projection, NOT the ctx-filtered result.
 *
 * `resolveCapabilities(ctx)` used to call `Array.from(byId.values())` on every
 * turn and re-run the full `visibility` filter. The fix memoizes only the
 * ctx-independent base (`Array.from(byId.values())`) and invalidates it on
 * `register()`. The ctx-dependent `visibility(base, ctx)` filter + capability
 * de-dupe still run FRESH per call — caching them would be a stale-cache
 * correctness bug (different ctx -> different surface).
 *
 * These tests pin the invalidation discipline:
 *  (a) register() invalidates  — a capability registered AFTER a first
 *      resolveCapabilities call appears on the very next call.
 *  (b) ctx-correctness          — two different ctx values yield correctly
 *      different filtered results from the SAME cached base.
 *  (c) base computed once       — across repeated same-state calls the SAME
 *      base array reference is handed to `visibility` (proof it was not
 *      re-materialised); a register() in between hands a fresh reference.
 */

import { describe, it, expect } from "vitest";
import {
  createToolRegistry,
  type CapabilityId,
  type ToolDefinition,
} from "../src/index.js";

function makeTool(id: string, capability: string): ToolDefinition {
  return {
    id,
    capability: capability as CapabilityId,
    description: id,
    inputSchema: {},
    outputSchema: {},
    intentKind: capability as ToolDefinition["intentKind"],
    riskLevel: "low",
    execute: async () => ({ ok: true }),
  };
}

/** A ctx that names which capabilities are visible (role-style filter). */
interface VisibilityCtx {
  readonly allow: ReadonlyArray<string>;
}

describe("resolveCapabilities memoization (PerformanceReviewer-002)", () => {
  it("(a) register() invalidates: a tool registered after a first resolve appears next call", () => {
    const reg = createToolRegistry();
    reg.register(makeTool("t.alpha", "cap.alpha"));

    const first = reg.resolveCapabilities(undefined);
    expect(first.map((d) => d.capability)).toEqual(["cap.alpha"]);

    // Mutate AFTER the cache was populated by the first call.
    reg.register(makeTool("t.beta", "cap.beta"));

    const second = reg.resolveCapabilities(undefined);
    expect(second.map((d) => d.capability).sort()).toEqual([
      "cap.alpha",
      "cap.beta",
    ]);
  });

  it("(a') register() invalidation also reflects in list()", () => {
    const reg = createToolRegistry();
    reg.register(makeTool("t.alpha", "cap.alpha"));
    expect(reg.list().map((t) => t.id)).toEqual(["t.alpha"]);

    reg.register(makeTool("t.beta", "cap.beta"));
    expect(reg.list().map((t) => t.id).sort()).toEqual(["t.alpha", "t.beta"]);
  });

  it("(b) the SAME cached base yields correctly-different results for different ctx", () => {
    const visibility = (
      tools: ReadonlyArray<ToolDefinition>,
      ctx: unknown,
    ): ReadonlyArray<ToolDefinition> => {
      const allow = (ctx as VisibilityCtx).allow;
      return tools.filter((t) => allow.includes(t.capability));
    };
    const reg = createToolRegistry({ visibility });
    reg.register(makeTool("t.alpha", "cap.alpha"));
    reg.register(makeTool("t.beta", "cap.beta"));
    reg.register(makeTool("t.gamma", "cap.gamma"));

    const ctxA: VisibilityCtx = { allow: ["cap.alpha"] };
    const ctxB: VisibilityCtx = { allow: ["cap.beta", "cap.gamma"] };

    // Two ctx values, one cached base — the filter MUST run fresh each time.
    expect(reg.resolveCapabilities(ctxA).map((d) => d.capability)).toEqual([
      "cap.alpha",
    ]);
    expect(
      reg.resolveCapabilities(ctxB).map((d) => d.capability).sort(),
    ).toEqual(["cap.beta", "cap.gamma"]);
    // And re-running ctxA still gives the ctxA answer (not a stale ctxB cache).
    expect(reg.resolveCapabilities(ctxA).map((d) => d.capability)).toEqual([
      "cap.alpha",
    ]);
  });

  it("(c) base is computed once across same-state calls; register() hands a fresh base", () => {
    // Spy `visibility`: it both counts invocations and captures the base
    // array reference it was handed. A memoized base => identical reference
    // across same-state calls (proof it was NOT re-materialised).
    let calls = 0;
    const seenBases: ReadonlyArray<ToolDefinition>[] = [];
    const visibility = (
      tools: ReadonlyArray<ToolDefinition>,
    ): ReadonlyArray<ToolDefinition> => {
      calls += 1;
      seenBases.push(tools);
      return tools;
    };
    const reg = createToolRegistry({ visibility });
    reg.register(makeTool("t.alpha", "cap.alpha"));

    reg.resolveCapabilities(undefined);
    reg.resolveCapabilities(undefined);
    reg.resolveCapabilities(undefined);

    expect(calls).toBe(3); // the FILTER runs every call (ctx-dependent) ...
    // ... but the BASE handed in is the very same reference each time.
    expect(seenBases[0]).toBe(seenBases[1]);
    expect(seenBases[1]).toBe(seenBases[2]);

    // A mutation must invalidate -> the next call gets a FRESH base reference.
    reg.register(makeTool("t.beta", "cap.beta"));
    reg.resolveCapabilities(undefined);
    expect(calls).toBe(4);
    expect(seenBases[3]).not.toBe(seenBases[2]);
  });

  it("de-dupes by capability (two tools, one descriptor) — unchanged by caching", () => {
    const reg = createToolRegistry();
    reg.register(makeTool("t.v1", "cap.shared"));
    reg.register(makeTool("t.v2", "cap.shared"));
    const out = reg.resolveCapabilities(undefined);
    expect(out.map((d) => d.capability)).toEqual(["cap.shared"]);
  });
});

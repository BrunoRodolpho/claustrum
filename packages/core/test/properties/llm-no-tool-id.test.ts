/**
 * PROPERTY: the LLM never sees a tool by its internal id.
 *
 * Per Hard Rule #1 + conformance CC-001. The LLM-facing surface is
 * exactly `[express_intent]`. The ToolRegistry exposes `capability`
 * to the planner via `resolveCapabilities()` — the `id` lives only on
 * the runtime side.
 *
 * This test asserts: `resolveCapabilities()` returns descriptors whose
 * fields are capability-shaped (no `id`), and a registered tool's
 * `id` never appears in any capability descriptor.
 *
 * Iterations: 200.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createToolRegistry, type CapabilityId, type IntentKind } from "../../src/index.js";

const ITERATIONS = 200;

describe("PROPERTY: LLM-facing capability surface never leaks tool id", () => {
  it(`holds for at least ${ITERATIONS} registries`, () => {
    let iterations = 0;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            capability: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rawTools) => {
          iterations += 1;
          const registry = createToolRegistry();
          let seq = 0;
          const knownIds: string[] = [];
          for (const t of rawTools) {
            seq += 1;
            // Distinct namespaces guarantee id-set and capability-set
            // cannot collide regardless of the random base strings.
            const id = `tool-id::${t.id}-${seq}`;
            const capability = `cap::${t.capability}-${seq}` as CapabilityId;
            const intentKind = capability as unknown as IntentKind;
            knownIds.push(id);
            registry.register({
              id,
              capability,
              description: id,
              inputSchema: {},
              outputSchema: {},
              intentKind,
              riskLevel: "low",
              execute: async () => ({ ok: true }),
            });
          }
          const descriptors = registry.resolveCapabilities({});
          // No descriptor should carry an `id` field.
          for (const d of descriptors) {
            if ("id" in d) return false;
            // No descriptor's capability should equal any known internal id.
            if (knownIds.includes(d.capability as unknown as string))
              return false;
          }
          return true;
        },
      ),
      { numRuns: ITERATIONS },
    );
    expect(iterations).toBeGreaterThanOrEqual(ITERATIONS);
  });
});

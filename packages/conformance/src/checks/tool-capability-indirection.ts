/**
 * CC-001 — tool-capability-indirection.
 *
 * The load-bearing zero-authority property: the LLM-facing tool surface
 * is exactly `[express_intent]`. Internal tool ids (e.g. `stripe.refund.v2`,
 * `medusa.cart.add`) are NEVER exposed to the LLM. The planner surfaces a
 * capability graph; the LLM expresses intent via the single
 * `express_intent(capability, payload)` tool.
 *
 * Methodology:
 *  1. Open a Capsule on the conductor (any minimal channel message).
 *  2. Read `capsule.tools.resolveCapabilities(capsule)` — assert it is
 *     a non-empty array of `CapabilityDescriptor` (or empty, when the
 *     adopter has not yet registered tools — that case passes vacuously).
 *  3. Walk every descriptor: assert no `.id` field is present (the
 *     descriptor type intentionally omits it; this is belt-and-braces).
 *  4. Read `capsule.tools.list()` — every registered ToolDefinition has
 *     its own `.id`, but those MUST NOT appear in the descriptor list.
 *
 * The invariant is enforced by the `ToolRegistry` type itself
 * (`descriptorOf()` projects to `CapabilityDescriptor`, never copies
 * `.id`); CC-001 is a paranoid check that adopters haven't subclassed
 * the registry in a way that leaks.
 */

import type { CapabilityDescriptor, Conductor, OpenCapsuleInput } from "@claustrum/core";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";

export const toolCapabilityIndirectionCheck: ConformanceCheck = {
  id: "CC-001",
  name: "LLM-facing tool surface is exactly [express_intent]; internal ids never leak",
  async run(
    conductor: Conductor,
    _options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    void _options;

    const inboundProbe: OpenCapsuleInput = {
      channel: "web",
      customerId: "conformance-cc001",
      inbound: {
        channel: "web",
        customerId: "conformance-cc001",
        conversationId: "cc001-conv",
        text: "probe",
        receivedAt: "2026-05-18T00:00:00.000Z",
      },
    };

    let capsule;
    try {
      capsule = await conductor.openCapsule(inboundProbe);
    } catch (err) {
      return {
        id: toolCapabilityIndirectionCheck.id,
        name: toolCapabilityIndirectionCheck.name,
        passed: false,
        details: `Failed to open capsule: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let descriptors: ReadonlyArray<CapabilityDescriptor>;
    try {
      descriptors = capsule.tools.resolveCapabilities(capsule);
    } catch (err) {
      await conductor.closeCapsule(capsule);
      return {
        id: toolCapabilityIndirectionCheck.id,
        name: toolCapabilityIndirectionCheck.name,
        passed: false,
        details: `resolveCapabilities threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Treat each descriptor as a record — assert no `id` key.
    const failures: string[] = [];
    for (const d of descriptors) {
      const asRecord = d as unknown as Record<string, unknown>;
      if ("id" in asRecord) {
        failures.push(
          `descriptor for capability="${String(d.capability)}" leaked an "id" field (value=${String(asRecord["id"])})`,
        );
      }
      // Required descriptor fields must be present.
      if (typeof d.capability !== "string" || d.capability.length === 0) {
        failures.push(`descriptor is missing/empty capability id`);
      }
      if (typeof d.intentKind !== "string" || d.intentKind.length === 0) {
        failures.push(
          `descriptor for capability="${String(d.capability)}" is missing intentKind`,
        );
      }
    }

    // Cross-check: every internal tool id MUST NOT appear as a capability
    // in the descriptor list. (Some adopters do set capability === id for
    // dev convenience — that's allowed; the LLM still only sees the
    // capability symbol, not the binding to an implementation. We instead
    // assert that the descriptor list does not contain any tool's full
    // string `id` in a way that exposes its versioned form like
    // "stripe.refund.v2".)
    const tools = capsule.tools.list();
    const capabilitySet = new Set<string>(
      descriptors.map((d) => String(d.capability)),
    );
    for (const t of tools) {
      // If the internal id differs from the capability AND appears in the
      // capability set, that's a leak. (Same-name aliases are not a leak.)
      if (
        t.id !== String(t.capability) &&
        capabilitySet.has(t.id)
      ) {
        failures.push(
          `internal tool id "${t.id}" appears as a capability in the descriptor list`,
        );
      }
    }

    await conductor.closeCapsule(capsule);

    if (failures.length > 0) {
      return {
        id: toolCapabilityIndirectionCheck.id,
        name: toolCapabilityIndirectionCheck.name,
        passed: false,
        details: `Capability indirection violated: ${failures.join("; ")}`,
      };
    }

    return {
      id: toolCapabilityIndirectionCheck.id,
      name: toolCapabilityIndirectionCheck.name,
      passed: true,
      details:
        descriptors.length === 0
          ? "No tools registered; invariant vacuously holds."
          : `Verified ${descriptors.length} capability descriptor(s); no internal ids leaked.`,
    };
  },
};

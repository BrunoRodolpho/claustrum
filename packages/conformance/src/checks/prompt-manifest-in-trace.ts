/**
 * CC-003 — prompt-manifest-in-trace.
 *
 * Every LLMTrace emitted via `TelemetryPort.emitLLMTrace` carries a
 * non-empty `promptManifest` whose entries match the documented fragment
 * id shape. This is the load-bearing property for replay-by-hash: months
 * later, an operator pulls the trace, looks up the fragment ids, and
 * reconstructs the byte-identical prompt that fed the model — even if
 * live fragments have evolved.
 *
 * Methodology:
 *  - Wrap the conductor's TelemetryPort to record every `emitLLMTrace`
 *    call; restore on exit.
 *  - Run `handleTurn` against the conductor `sampling` times.
 *  - After all turns, assert every recorded LLMTrace has:
 *      - non-empty `promptManifest`
 *      - every entry is a string of length ≥ 1
 *      - each entry matches `/^[a-zA-Z0-9_.\-:/]+$/` (loose fragment id
 *        shape — adopters may use namespaced ids like
 *        "voice.formal.pt-br")
 *
 * If the adopter's Conductor doesn't call `emitLLMTrace` (e.g., a pure
 * stub-adjudicator setup with no real LLM), the check passes vacuously
 * with a "no LLM traces emitted" note.
 *
 * Caveat: the FROZEN `handleTurn` does NOT call `emitLLMTrace` directly
 * — that's the ResponderPort/PlannerPort's job (they call the LLM and
 * record the trace). So adopters whose Planner/Responder don't emit a
 * trace pass vacuously; adopters whose Planner/Responder DO emit a trace
 * are bound by this invariant.
 */

import {
  handleTurn,
  type Conductor,
  type LLMTrace,
  type MemoryAccess,
  type OpenCapsuleInput,
  type TelemetryPort,
  type TurnRecord,
} from "@claustrum/core";
import { lcg } from "../prng.js";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";

const FRAGMENT_ID_PATTERN = /^[a-zA-Z0-9_.\-:/]+$/;

export const promptManifestInTraceCheck: ConformanceCheck = {
  id: "CC-003",
  name: "Every LLMTrace carries a non-empty promptManifest",
  async run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    const sampling = options.sampling ?? 100;
    const seed = options.seed ?? 42;
    const rng = lcg(seed);

    // Probe one capsule to discover the telemetry port. We wrap that
    // port's `emitLLMTrace` to record every emission; restore on exit.
    const inboundProbe: OpenCapsuleInput = {
      channel: "web",
      customerId: "cc003-probe",
      inbound: {
        channel: "web",
        customerId: "cc003-probe",
        conversationId: "cc003-conv",
        text: "probe",
        receivedAt: "2026-05-18T00:00:00.000Z",
      },
    };

    let probeCapsule;
    try {
      probeCapsule = await conductor.openCapsule(inboundProbe);
    } catch (err) {
      return {
        id: promptManifestInTraceCheck.id,
        name: promptManifestInTraceCheck.name,
        passed: false,
        details: `Failed to open probe capsule: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const telemetry = probeCapsule.telemetry as TelemetryPort;
    await conductor.closeCapsule(probeCapsule);

    const traces: LLMTrace[] = [];
    const originalEmitLLMTrace = telemetry.emitLLMTrace.bind(telemetry);
    const mutableTelemetry = telemetry as unknown as {
      emitLLMTrace: (trace: LLMTrace) => Promise<void>;
      emitTurn: (turn: TurnRecord) => Promise<void>;
      emitMemoryAccess: (access: MemoryAccess) => Promise<void>;
    };

    mutableTelemetry.emitLLMTrace = async (trace: LLMTrace): Promise<void> => {
      traces.push(trace);
      return originalEmitLLMTrace(trace);
    };

    try {
      for (let i = 0; i < sampling; i++) {
        const ridx = Math.floor(rng() * 0xffffffff);
        const text = `cc003-turn-${i}-${ridx}`;
        const inbound: OpenCapsuleInput = {
          channel: "web",
          customerId: `cc003-cust-${i % 5}`,
          inbound: {
            channel: "web",
            customerId: `cc003-cust-${i % 5}`,
            conversationId: `cc003-conv-${i % 5}`,
            text,
            receivedAt: "2026-05-18T00:00:00.000Z",
          },
        };
        let capsule;
        try {
          capsule = await conductor.openCapsule(inbound);
        } catch {
          continue;
        }
        try {
          await handleTurn(capsule, inbound.inbound);
        } catch {
          // turn errors are out of scope for CC-003 — they're CC-002 / CC-004 territory
        }
        await conductor.closeCapsule(capsule);
      }
    } finally {
      mutableTelemetry.emitLLMTrace = originalEmitLLMTrace;
    }

    if (traces.length === 0) {
      return {
        id: promptManifestInTraceCheck.id,
        name: promptManifestInTraceCheck.name,
        passed: true,
        details:
          `No LLM traces emitted across ${sampling} turn(s); invariant vacuously holds. ` +
          `Wire ResponderPort/PlannerPort to call telemetry.emitLLMTrace to exercise this check.`,
      };
    }

    const failures: string[] = [];
    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      if (trace === undefined) continue;
      if (!Array.isArray(trace.promptManifest) || trace.promptManifest.length === 0) {
        failures.push(
          `trace ${i} (turnId=${trace.turnId}) has empty promptManifest`,
        );
        continue;
      }
      for (let j = 0; j < trace.promptManifest.length; j++) {
        const entry = trace.promptManifest[j];
        if (typeof entry !== "string" || entry.length === 0) {
          failures.push(
            `trace ${i} entry ${j} is not a non-empty string (got ${JSON.stringify(entry)})`,
          );
          break;
        }
        if (!FRAGMENT_ID_PATTERN.test(entry)) {
          failures.push(
            `trace ${i} entry ${j} = "${entry}" doesn't match fragment-id pattern`,
          );
          break;
        }
      }
      if (failures.length >= 10) break;
    }

    if (failures.length > 0) {
      return {
        id: promptManifestInTraceCheck.id,
        name: promptManifestInTraceCheck.name,
        passed: false,
        details: `Prompt-manifest invariant violated: ${failures.join("; ")}`,
      };
    }

    return {
      id: promptManifestInTraceCheck.id,
      name: promptManifestInTraceCheck.name,
      passed: true,
      details: `Verified ${traces.length} LLM trace(s); every promptManifest non-empty and well-formed.`,
    };
  },
};

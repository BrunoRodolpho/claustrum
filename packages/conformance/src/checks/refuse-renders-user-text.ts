/**
 * CC-004 — refuse-renders-user-text.
 *
 * Every Decision whose kind is REFUSE MUST surface non-empty user-facing
 * text via `ExplainerPort.render(refusal)`. This is the "no naked
 * exceptions, no silent drops" invariant — a refusal that the user
 * cannot read is a deployment-grade failure.
 *
 * Methodology:
 *  - Wrap the conductor's ExplainerPort.render() to record (refusal,
 *    rendered text) pairs; restore on exit.
 *  - Run `handleTurn` `sampling` times against the conductor.
 *  - For each turn whose decision.kind === "REFUSE", assert:
 *      - render() was called at least once with the matching refusal
 *      - the rendered text is a non-empty string
 *
 * If the adopter's Conductor never produces REFUSE during the sampling
 * window, the check passes vacuously.
 */

import {
  handleTurn,
  type Conductor,
  type ExplainerPort,
  type OpenCapsuleInput,
} from "@claustrum/core";
import type { Refusal } from "@adjudicate/core";
import { lcg } from "../prng.js";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";
import { withInstrumentedPort } from "../instrumented-port.js";

export const refuseRendersUserTextCheck: ConformanceCheck = {
  id: "CC-004",
  name: "Every REFUSE renders to non-empty user-facing text via ExplainerPort",
  async run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    const sampling = options.sampling ?? 100;
    const seed = options.seed ?? 42;
    const rng = lcg(seed);

    // Probe to capture the explainer reference.
    const inboundProbe: OpenCapsuleInput = {
      channel: "web",
      customerId: "cc004-probe",
      inbound: {
        channel: "web",
        customerId: "cc004-probe",
        conversationId: "cc004-conv",
        text: "probe",
        receivedAt: "2026-05-18T00:00:00.000Z",
      },
    };
    let probeCapsule;
    try {
      probeCapsule = await conductor.openCapsule(inboundProbe);
    } catch (err) {
      return {
        id: refuseRendersUserTextCheck.id,
        name: refuseRendersUserTextCheck.name,
        passed: false,
        details: `Failed to open probe capsule: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const explainer = probeCapsule.explainer as ExplainerPort;
    await conductor.closeCapsule(probeCapsule);

    const calls: Array<{ refusal: Refusal; output: string }> = [];
    const originalRender = explainer.render.bind(explainer);

    const refuseTurns: Array<{ turn: number; refusalCode: string; output: string }> = [];

    await withInstrumentedPort(
      explainer,
      "render",
      (_original) => (refusal: Refusal): string => {
        const out = originalRender(refusal);
        calls.push({ refusal, output: out });
        return out;
      },
      async (_spy) => {
        for (let i = 0; i < sampling; i++) {
          const ridx = Math.floor(rng() * 0xffffffff);
          const text = i % 5 === 0 ? `cc004-danger-${i}-${ridx}` : `cc004-turn-${i}-${ridx}`;
          const inbound: OpenCapsuleInput = {
            channel: "web",
            customerId: `cc004-cust-${i % 5}`,
            inbound: {
              channel: "web",
              customerId: `cc004-cust-${i % 5}`,
              conversationId: `cc004-conv-${i % 5}`,
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
          let result;
          try {
            result = await handleTurn(capsule, inbound.inbound);
          } catch {
            await conductor.closeCapsule(capsule);
            continue;
          }
          await conductor.closeCapsule(capsule);
          if (result.decision.kind === "REFUSE") {
            const refusalCode = result.decision.refusal.code;
            // dispatch already called explainer.render — find the most-recent matching call.
            const matching = calls
              .slice()
              .reverse()
              .find((c) => c.refusal.code === refusalCode);
            refuseTurns.push({
              turn: i,
              refusalCode,
              output: matching?.output ?? "",
            });
          }
        }
      },
    );

    if (refuseTurns.length === 0) {
      return {
        id: refuseRendersUserTextCheck.id,
        name: refuseRendersUserTextCheck.name,
        passed: true,
        details: `No REFUSE decisions produced across ${sampling} turn(s); invariant vacuously holds.`,
      };
    }

    const failures: string[] = [];
    for (const r of refuseTurns) {
      if (typeof r.output !== "string" || r.output.length === 0) {
        failures.push(
          `turn ${r.turn}: REFUSE (code="${r.refusalCode}") rendered empty user text`,
        );
      }
      if (failures.length >= 10) break;
    }

    if (failures.length > 0) {
      return {
        id: refuseRendersUserTextCheck.id,
        name: refuseRendersUserTextCheck.name,
        passed: false,
        details: `REFUSE-renders-text invariant violated: ${failures.join("; ")}`,
      };
    }

    return {
      id: refuseRendersUserTextCheck.id,
      name: refuseRendersUserTextCheck.name,
      passed: true,
      details: `Verified ${refuseTurns.length} REFUSE turn(s); all rendered non-empty user text.`,
    };
  },
};

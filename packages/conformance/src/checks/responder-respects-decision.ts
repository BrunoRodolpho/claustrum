/**
 * CC-007 — responder-respects-decision.
 *
 * The `ResponderPort` is handed the kernel `Decision` (`input.decision`) on
 * every turn (`packages/core/src/ports/responder.ts`). A *decision-aware*
 * responder MUST let that decision shape its draft — it must not synthesize a
 * reply from the user's text alone while ignoring what the kernel actually
 * decided. The load-bearing failure this catches: a chat reply that contradicts
 * the audited decision (e.g. the kernel REFUSEd `order.not_found` but the bot
 * cheerfully answers as if it could act). Chat text contradicting the audit
 * ledger is a correctness/compliance defect, not a tone nit.
 *
 * The strongest, deterministically-checkable slice of "respects the decision":
 *  - On a REFUSE of a PROPOSED action (the plan had ≥1 envelope), the draft
 *    MUST surface the refusal that `ExplainerPort.render` produces (model-free,
 *    single-sourced). A decision-blind responder that calls the model on the
 *    raw user text will NOT contain the explainer's refusal text.
 *  - The draft reflects `decision.kind`: across the sample, the set of those
 *    REFUSE drafts is disjoint from the set of non-REFUSE drafts (the
 *    responder's output varies with the decision, not only with user input).
 *
 * A REFUSE on an EMPTY plan (no envelope proposed — e.g. small-talk that some
 * adopters fail-closed into a "nothing to authorize" refusal) is EXEMPT: there
 * is no proposed action for the reply to contradict, so the responder is free
 * to answer conversationally. The discriminator is `plan.envelopes.length`,
 * which is generic (no adopter-specific refusal-code knowledge).
 *
 * Methodology (mirrors CC-004/CC-003):
 *  - Probe one capsule to capture the conductor's `responder` + `explainer`
 *    ports.
 *  - Wrap `responder.respond` via `withInstrumentedPort` to record, per call,
 *    the `decision.kind`, the returned draft text, and (for REFUSE) the text
 *    `explainer.render(refusal)` would produce; restore on exit.
 *  - Drive `handleTurn` `sampling` times with a mix of benign and "danger"
 *    inputs so both REFUSE and non-REFUSE decisions occur.
 *  - Assert the two invariants above.
 *
 * If the adopter's Conductor never produces a REFUSE during the sampling
 * window, the refusal invariant holds vacuously (mirrors CC-004) and the check
 * passes with a note.
 */

import {
  handleTurn,
  type Conductor,
  type ExplainerPort,
  type OpenCapsuleInput,
  type ResponderPort,
} from "@claustrum/core";
import { lcg } from "../prng.js";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";
import { withInstrumentedPort } from "../instrumented-port.js";

interface RespondCall {
  readonly decisionKind: string;
  readonly text: string;
  /** Number of envelopes the planner proposed this turn (0 ⇒ no action). */
  readonly plannedEnvelopes: number;
  /** For REFUSE: the text `explainer.render(refusal)` produced. */
  readonly expectedRefusalText?: string;
}

export const responderRespectsDecisionCheck: ConformanceCheck = {
  id: "CC-007",
  name: "ResponderPort respects the kernel Decision (REFUSE surfaces the explainer refusal; drafts reflect decision.kind)",
  async run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    const sampling = options.sampling ?? 100;
    const seed = options.seed ?? 42;
    const rng = lcg(seed);

    const inboundProbe: OpenCapsuleInput = {
      channel: "web",
      customerId: "cc007-probe",
      inbound: {
        channel: "web",
        customerId: "cc007-probe",
        conversationId: "cc007-conv",
        text: "probe",
        receivedAt: "2026-05-18T00:00:00.000Z",
      },
    };

    let probeCapsule;
    try {
      probeCapsule = await conductor.openCapsule(inboundProbe);
    } catch (err) {
      return {
        id: responderRespectsDecisionCheck.id,
        name: responderRespectsDecisionCheck.name,
        passed: false,
        details: `Failed to open probe capsule: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const responder = probeCapsule.responder as ResponderPort;
    const explainer = probeCapsule.explainer as ExplainerPort;
    await conductor.closeCapsule(probeCapsule);

    const calls: RespondCall[] = [];
    const originalRespond = responder.respond.bind(responder);

    await withInstrumentedPort(
      responder,
      "respond",
      (_original) =>
        async (input: Parameters<ResponderPort["respond"]>[0]) => {
          const draft = await originalRespond(input);
          const decision = input.decision;
          let expectedRefusalText: string | undefined;
          if (decision.kind === "REFUSE") {
            try {
              expectedRefusalText = explainer.render(decision.refusal);
            } catch {
              expectedRefusalText = undefined;
            }
          }
          calls.push({
            decisionKind: decision.kind,
            text: draft.text,
            plannedEnvelopes: input.plan.envelopes.length,
            ...(expectedRefusalText !== undefined ? { expectedRefusalText } : {}),
          });
          return draft;
        },
      async (_spy) => {
        for (let i = 0; i < sampling; i++) {
          const ridx = Math.floor(rng() * 0xffffffff);
          // Every 5th turn carries "danger" so the StubAdjudicator (and any
          // adopter policy that refuses dangerous intents) produces a REFUSE.
          const text =
            i % 5 === 0
              ? `cc007-danger-${i}-${ridx}`
              : `cc007-turn-${i}-${ridx}`;
          const inbound: OpenCapsuleInput = {
            channel: "web",
            customerId: `cc007-cust-${i % 5}`,
            inbound: {
              channel: "web",
              customerId: `cc007-cust-${i % 5}`,
              conversationId: `cc007-conv-${i % 5}`,
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
            // Turn errors are out of scope for CC-007 (CC-002/CC-004 territory).
          }
          await conductor.closeCapsule(capsule);
        }
      },
    );

    // Only REFUSEs of a PROPOSED action are enforceable — a REFUSE on an empty
    // plan is the "nothing to authorize" sentinel and is exempt (see header).
    const refuseCalls = calls.filter(
      (c) => c.decisionKind === "REFUSE" && c.plannedEnvelopes > 0,
    );
    const nonRefuseCalls = calls.filter((c) => c.decisionKind !== "REFUSE");

    if (refuseCalls.length === 0) {
      return {
        id: responderRespectsDecisionCheck.id,
        name: responderRespectsDecisionCheck.name,
        passed: true,
        details:
          `No REFUSE-of-a-proposed-action produced across ${sampling} turn(s); the ` +
          `refusal invariant holds vacuously. Wire a policy that REFUSEs a proposed ` +
          `intent to exercise this check.`,
      };
    }

    const failures: string[] = [];

    // Invariant 1 — REFUSE drafts single-source the explainer (decision-aware,
    // model-free). A decision-blind responder fails here.
    for (let i = 0; i < refuseCalls.length; i++) {
      const c = refuseCalls[i]!;
      if (typeof c.text !== "string" || c.text.length === 0) {
        failures.push(`REFUSE draft #${i} is empty`);
      } else if (
        typeof c.expectedRefusalText === "string" &&
        c.expectedRefusalText.length > 0 &&
        !c.text.includes(c.expectedRefusalText)
      ) {
        failures.push(
          `REFUSE draft #${i} does not surface the explainer refusal text ` +
            `(draft=${JSON.stringify(c.text.slice(0, 80))}, ` +
            `expected to contain=${JSON.stringify(c.expectedRefusalText.slice(0, 80))}) ` +
            `— the responder ignored the decision and synthesized from user text`,
        );
      }
      if (failures.length >= 10) break;
    }

    // Invariant 2 — the draft reflects decision.kind: REFUSE drafts are disjoint
    // from non-REFUSE drafts (output varies with the decision, not just input).
    if (failures.length === 0 && nonRefuseCalls.length > 0) {
      const refuseTexts = new Set(refuseCalls.map((c) => c.text));
      const collision = nonRefuseCalls.find((c) => refuseTexts.has(c.text));
      if (collision !== undefined) {
        failures.push(
          `a draft (${JSON.stringify(collision.text.slice(0, 80))}) appears under both ` +
            `REFUSE and ${collision.decisionKind} — the responder's output does not ` +
            `reflect decision.kind`,
        );
      }
    }

    if (failures.length > 0) {
      return {
        id: responderRespectsDecisionCheck.id,
        name: responderRespectsDecisionCheck.name,
        passed: false,
        details: `Responder-respects-decision invariant violated: ${failures.join("; ")}`,
      };
    }

    return {
      id: responderRespectsDecisionCheck.id,
      name: responderRespectsDecisionCheck.name,
      passed: true,
      details:
        `Verified ${refuseCalls.length} REFUSE draft(s) surface the explainer refusal ` +
        `verbatim and stay disjoint from ${nonRefuseCalls.length} non-REFUSE draft(s).`,
    };
  },
};

/**
 * BKL-063 — dispatch parks ALL friction-verb envelopes, not just envelopes[0].
 *
 * `adjudicatePlan` is transactional (kill-all-or-execute-all): a plan-level
 * friction verd (REQUEST_CONFIRMATION / DEFER / ESCALATE) gates EVERY envelope.
 * The old dispatch parked/queued only `envelopes[0]` (`pickEnvelope`), so the
 * SECOND envelope of a compound customer message silently VANISHED on resume
 * (ibatexas ground-truth L4 sibling). The fix parks/queues every envelope, in
 * order, keyed by its own intentHash — so resume replays each correctly and the
 * single-envelope path stays byte-identical.
 *
 * Pins:
 *  - a 2-envelope REQUEST_CONFIRMATION parks BOTH (order preserved);
 *  - DEFER parks both; ESCALATE queues both to the handoff;
 *  - a friction verb NEVER executes a tool (never-weaken — no mutation runs);
 *  - single-envelope results are byte-identical (`{ envelope }`, no `envelopes`);
 *  - no double-park when the plan repeats an intentHash;
 *  - per-envelope keying: unpark removes exactly one, leaving the sibling — so
 *    resume replays the RIGHT envelope and never the wrong one.
 */

import { describe, it, expect } from "vitest";
import {
  decisionRequestConfirmation,
  decisionDefer,
  decisionEscalate,
  type IntentEnvelope,
} from "@adjudicate/core";
import type { HandoffPort, Plan, ResponderPort } from "../../src/index.js";
import { dispatchDecision } from "../../src/execution/dispatch.js";
import { buildHarness, buildTestEnvelope, makeTool } from "./harness.js";

const passResponder: ResponderPort = {
  async respond() {
    return { text: "ok" };
  },
};

/** A handoff that records every queued (envelope, reason). */
function recordingHandoff(): HandoffPort & {
  readonly queued: Array<{ envelope: IntentEnvelope; reason: string }>;
} {
  const queued: Array<{ envelope: IntentEnvelope; reason: string }> = [];
  return {
    queued,
    async queue(envelope, reason) {
      queued.push({ envelope, reason });
    },
  };
}

/** A tool that records every invocation, so we can prove a friction verb executes nothing. */
function neverCalledTool(kind: string, calls: string[]) {
  return makeTool({
    id: `${kind}.tool`,
    capability: kind,
    intentKind: kind,
    execute: async () => {
      calls.push(kind);
      return "should-not-run";
    },
  });
}

const CUSTOMER = "cust-test";

describe("dispatch — parks ALL friction-verb envelopes (BKL-063)", () => {
  it("REQUEST_CONFIRMATION on a 2-envelope plan parks BOTH, in order, none executed", async () => {
    const calls: string[] = [];
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      tools: [neverCalledTool("a.cap", calls), neverCalledTool("b.cap", calls)],
    });
    const envA = buildTestEnvelope({ kind: "a.cap" });
    const envB = buildTestEnvelope({ kind: "b.cap" });
    const plan: Plan = { envelopes: [envA, envB] };

    const acted = await dispatchDecision(
      decisionRequestConfirmation("Confirma A e B?", []),
      plan,
      capsule,
    );

    expect(acted.kind).toBe("awaiting_confirmation");
    if (acted.kind === "awaiting_confirmation") {
      // Both surfaced on the result, in plan order; `envelope` is the first.
      expect(acted.envelope?.intentHash).toBe(envA.intentHash);
      expect(acted.envelopes?.map((e) => e.intentHash)).toEqual([
        envA.intentHash,
        envB.intentHash,
      ]);
    }

    // BOTH parked on the session, in order — envelopes[1] no longer vanishes.
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations.map((p) => p.envelope.intentHash)).toEqual([
      envA.intentHash,
      envB.intentHash,
    ]);
    // Never-weaken: a confirmation executes NOTHING.
    expect(calls).toEqual([]);
  });

  it("DEFER on a 2-envelope plan parks BOTH deferred envelopes (order preserved)", async () => {
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
    });
    const envA = buildTestEnvelope({ kind: "a.cap" });
    const envB = buildTestEnvelope({ kind: "b.cap" });
    const plan: Plan = { envelopes: [envA, envB] };

    const acted = await dispatchDecision(
      decisionDefer("await_stock", 60_000, []),
      plan,
      capsule,
    );

    expect(acted.kind).toBe("deferred");
    if (acted.kind === "deferred") {
      expect(acted.envelopes?.map((e) => e.intentHash)).toEqual([
        envA.intentHash,
        envB.intentHash,
      ]);
    }
    const after = await session.load(CUSTOMER, "web");
    expect(after.deferredEnvelopes.map((d) => d.envelope.intentHash)).toEqual([
      envA.intentHash,
      envB.intentHash,
    ]);
    // A single, shared deferUntil for the whole plan.
    expect(new Set(after.deferredEnvelopes.map((d) => d.deferUntil)).size).toBe(1);
  });

  it("ESCALATE on a 2-envelope plan queues BOTH to the handoff (order preserved)", async () => {
    const handoff = recordingHandoff();
    const { capsule } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
      handoff,
    });
    const envA = buildTestEnvelope({ kind: "a.cap" });
    const envB = buildTestEnvelope({ kind: "b.cap" });
    const plan: Plan = { envelopes: [envA, envB] };

    const acted = await dispatchDecision(
      decisionEscalate("human", "needs a person", []),
      plan,
      capsule,
    );

    expect(acted.kind).toBe("escalated");
    if (acted.kind === "escalated") {
      expect(acted.envelopes?.map((e) => e.intentHash)).toEqual([
        envA.intentHash,
        envB.intentHash,
      ]);
    }
    expect(handoff.queued.map((q) => q.envelope.intentHash)).toEqual([
      envA.intentHash,
      envB.intentHash,
    ]);
    expect(handoff.queued.every((q) => q.reason === "needs a person")).toBe(true);
  });

  it("single-envelope REQUEST_CONFIRMATION is byte-identical (`{ envelope }`, no `envelopes`)", async () => {
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
    });
    const env = buildTestEnvelope({ kind: "a.cap" });
    const plan: Plan = { envelopes: [env] };

    const acted = await dispatchDecision(
      decisionRequestConfirmation("Confirma?", []),
      plan,
      capsule,
    );

    expect(acted.kind).toBe("awaiting_confirmation");
    if (acted.kind === "awaiting_confirmation") {
      expect(acted.envelope?.intentHash).toBe(env.intentHash);
      // The multi-envelope field is ABSENT for a single-envelope plan.
      expect(acted.envelopes).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(acted, "envelopes")).toBe(false);
    }
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(1);
    expect(after.pendingConfirmations[0]!.envelope.intentHash).toBe(env.intentHash);
  });

  it("an empty plan parks nothing and still returns the typed friction result", async () => {
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
    });
    const acted = await dispatchDecision(
      decisionRequestConfirmation("Confirma?", []),
      { envelopes: [] },
      capsule,
    );
    expect(acted.kind).toBe("awaiting_confirmation");
    if (acted.kind === "awaiting_confirmation") {
      expect(acted.envelope).toBeUndefined();
      expect(acted.envelopes).toBeUndefined();
    }
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(0);
  });

  it("no double-park: a plan that repeats an intentHash parks it exactly once", async () => {
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
    });
    const env = buildTestEnvelope({ kind: "a.cap" });
    // The SAME envelope twice → one intentHash → one parked slot.
    const plan: Plan = { envelopes: [env, env] };

    const acted = await dispatchDecision(
      decisionRequestConfirmation("Confirma?", []),
      plan,
      capsule,
    );

    expect(acted.kind).toBe("awaiting_confirmation");
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(1);
    if (acted.kind === "awaiting_confirmation") {
      // Deduped to a single envelope → no multi-envelope field.
      expect(acted.envelopes).toBeUndefined();
    }
  });

  it("per-envelope keying: unpark removes exactly one, leaving the sibling (resume replays the right one)", async () => {
    const { capsule, session } = await buildHarness({
      planner: { async propose() { return { envelopes: [] }; } },
      responder: passResponder,
    });
    const envA = buildTestEnvelope({ kind: "a.cap" });
    const envB = buildTestEnvelope({ kind: "b.cap" });
    const plan: Plan = { envelopes: [envA, envB] };

    await dispatchDecision(
      decisionRequestConfirmation("Confirma A e B?", []),
      plan,
      capsule,
    );

    // Resume of envelope B unparks ONLY B; A stays parked and independently
    // resumable — the two never cross-contaminate.
    await capsule.session.unpark(capsule.loadedSession.id, envB.intentHash);
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations.map((p) => p.envelope.intentHash)).toEqual([
      envA.intentHash,
    ]);
  });
});

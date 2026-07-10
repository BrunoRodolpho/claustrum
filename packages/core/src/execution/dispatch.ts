/**
 * Decision dispatch — handles every Decision variant from @adjudicate/core.
 *
 * Per PART I §"Decision handling matrix": every variant has a defined
 * runtime response. There are no throws. The matrix:
 *
 *   EXECUTE              -> resolve tool by intentKind; invoke
 *   REWRITE              -> recurse with the rewritten envelope as EXECUTE
 *   REFUSE               -> render via explainer
 *   REQUEST_CONFIRMATION -> park envelope; surface prompt
 *   DEFER                -> park deferred envelope
 *   ESCALATE             -> queue for human via HandoffPort
 *
 * The Capsule's ToolRegistry resolves capability -> implementation.
 * The IntentEnvelope.kind matches the tool's `intentKind`, so the
 * dispatcher looks up by kind directly.
 */

import { DEFAULT_ORIGIN, type Decision, type IntentEnvelope } from "@adjudicate/core";
import type { Capsule } from "../capsule.js";
import type { Plan } from "../ports/planner.js";
import type { ToolRegistry } from "../tools/registry.js";
import { asCapability, type CapabilityId } from "../tools/types.js";

export type DispatchResult =
  | {
      readonly kind: "executed";
      readonly envelope: IntentEnvelope;
      readonly toolId: string;
      readonly result: unknown;
    }
  | {
      readonly kind: "rewritten_and_executed";
      readonly envelope: IntentEnvelope;
      readonly toolId: string;
      readonly result: unknown;
      readonly reason: string;
    }
  | {
      /**
       * A multi-envelope plan (adjudicatePlan, transactional kill-all-or-execute-all)
       * adjudicated to EXECUTE — every envelope was approved, so dispatch ran each in
       * order (LogicReviewer-003). One execution per envelope, in plan order. The
       * single-envelope EXECUTE still yields `kind: "executed"` (byte-equivalent).
       */
      readonly kind: "executed_plan";
      readonly executions: ReadonlyArray<{
        readonly envelope: IntentEnvelope;
        readonly toolId: string;
        readonly result: unknown;
      }>;
    }
  | {
      readonly kind: "refused";
      readonly userText: string;
      readonly code: string;
      readonly refusalKind: string;
    }
  | {
      readonly kind: "awaiting_confirmation";
      readonly prompt: string;
      /** The FIRST parked envelope (byte-compat with the single-envelope path). */
      readonly envelope?: IntentEnvelope;
      /**
       * EVERY envelope parked for this confirmation, in plan order (BKL-063). A
       * multi-envelope plan (a compound customer message) that adjudicates to
       * REQUEST_CONFIRMATION parks ALL its envelopes, not just `envelopes[0]`, so
       * none silently vanishes on resume. Present ONLY when more than one was
       * parked; a single-envelope confirmation omits it (byte-identical) and its
       * one envelope is `envelope`. Resume reads `session.pendingConfirmations`,
       * not this field — it is surfaced for observability / adopter UIs.
       */
      readonly envelopes?: ReadonlyArray<IntentEnvelope>;
    }
  | {
      readonly kind: "deferred";
      readonly signal: string;
      readonly timeoutMs: number;
      /** The FIRST deferred envelope (byte-compat with the single-envelope path). */
      readonly envelope?: IntentEnvelope;
      /** EVERY deferred envelope, in plan order (BKL-063; present only when >1). */
      readonly envelopes?: ReadonlyArray<IntentEnvelope>;
    }
  | {
      readonly kind: "escalated";
      readonly to: "human" | "supervisor";
      readonly reason: string;
      /** The FIRST escalated envelope (byte-compat with the single-envelope path). */
      readonly envelope?: IntentEnvelope;
      /** EVERY envelope queued to handoff, in plan order (BKL-063; present only when >1). */
      readonly envelopes?: ReadonlyArray<IntentEnvelope>;
    }
  | {
      /**
       * A port the runtime called to honor the Decision threw. Dispatch is
       * total — it converts the throw into this typed result instead of
       * rejecting, so handleTurn always reaches SYNTHESIZE/OBSERVE (a user
       * reply, telemetry, and an audit outcome are produced). `message` is
       * operator-facing and MUST NOT be rendered to the user verbatim — it can
       * carry capability ids or internal error text.
       */
      readonly kind: "failed";
      readonly phase: Decision["kind"];
      readonly code: DispatchFailureCode;
      readonly message: string;
      readonly envelope?: IntentEnvelope;
    };

export type DispatchFailureCode =
  | "tool_unresolved"
  | "tool_threw"
  | "explainer_threw"
  | "park_threw"
  | "handoff_threw";

function dispatchErrorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export async function dispatchDecision(
  decision: Decision,
  plan: Plan,
  capsule: Capsule,
): Promise<DispatchResult> {
  switch (decision.kind) {
    case "EXECUTE": {
      // adjudicatePlan is transactional (kill-all-or-execute-all): a plan-level
      // EXECUTE approved EVERY envelope, so dispatch each in order. The old
      // pickEnvelope(plan) ran only envelopes[0], silently dropping envelopes[1..n]
      // (LogicReviewer-003). The single-envelope hot path stays byte-equivalent.
      const envelopes = plan.envelopes;
      if (envelopes.length === 0) {
        // No envelope -> nothing to execute. Treat as a no-op dispatch.
        return {
          kind: "executed",
          envelope: emptyEnvelope(),
          toolId: "<noop>",
          result: undefined,
        };
      }
      if (envelopes.length === 1) {
        return executeEnvelope(envelopes[0] as IntentEnvelope, capsule);
      }
      // Multi-envelope plan: run each envelope's tool in order. A single envelope's
      // failure aborts the plan with that typed failure (dispatch has no cross-tool
      // compensation — multi-envelope rollback is a documented kernel-level concern,
      // out of scope here). All-success -> executed_plan, one execution per envelope.
      const executions: Array<{
        envelope: IntentEnvelope;
        toolId: string;
        result: unknown;
      }> = [];
      for (const envelope of envelopes) {
        const r = await executeEnvelope(envelope, capsule);
        if (r.kind !== "executed") return r;
        executions.push({
          envelope: r.envelope,
          toolId: r.toolId,
          result: r.result,
        });
      }
      return { kind: "executed_plan", executions };
    }

    case "REWRITE": {
      const envelope = decision.rewritten;
      const capability = inferCapability(envelope, capsule.tools);
      if (capability === undefined) {
        return {
          kind: "failed",
          phase: "REWRITE",
          code: "tool_unresolved",
          message: unknownCapabilityMessage(envelope.kind),
          envelope,
        };
      }
      try {
        const tool = capsule.tools.resolveTool(capability, capsule);
        try {
          const result = await tool.execute(envelope.payload, capsule);
          return {
            kind: "rewritten_and_executed",
            envelope,
            toolId: tool.id,
            result,
            reason: decision.reason,
          };
        } catch (e) {
          return {
            kind: "failed",
            phase: "REWRITE",
            code: "tool_threw",
            message: dispatchErrorMessage(e),
            envelope,
          };
        }
      } catch (e) {
        return {
          kind: "failed",
          phase: "REWRITE",
          code: "tool_unresolved",
          message: dispatchErrorMessage(e),
          envelope,
        };
      }
    }

    case "REFUSE": {
      // "REFUSE -> non-empty user-facing text" is an invariant, so an
      // explainer template miss must still yield a refusal — fall back to a
      // generic safe text rather than crashing or returning a bare failure.
      try {
        const userText = capsule.explainer.render(decision.refusal);
        return {
          kind: "refused",
          userText,
          code: decision.refusal.code,
          refusalKind: decision.refusal.kind,
        };
      } catch {
        return {
          kind: "refused",
          userText: GENERIC_REFUSAL_TEXT,
          code: decision.refusal.code,
          refusalKind: decision.refusal.kind,
        };
      }
    }

    case "REQUEST_CONFIRMATION": {
      // adjudicatePlan is transactional (kill-all-or-execute-all): a plan-level
      // REQUEST_CONFIRMATION gates EVERY envelope, so park EVERY envelope — not
      // just envelopes[0] (BKL-063). The old pickEnvelope(plan) parked only the
      // first, silently DROPPING envelopes[1..n] of a compound customer message
      // so they vanished on resume. Order is preserved and each carries its own
      // intentHash key, so resume replays the right one per matched reply. The
      // single-envelope path is byte-identical (loop of one, same park args).
      const envelopes = frictionEnvelopes(plan);
      for (const envelope of envelopes) {
        // Park each so the next-turn reply can be matched. If ANY park fails the
        // confirmation can never be honored, so surface a failure rather than
        // falsely telling the user "awaiting confirmation" (same fail-safe as
        // before, now per-envelope). No mutation ran — parking is a session write.
        try {
          await capsule.session.parkPendingConfirmation(
            capsule.loadedSession.id,
            envelope,
            envelope.intentHash,
            decision.prompt,
          );
        } catch (e) {
          return {
            kind: "failed",
            phase: "REQUEST_CONFIRMATION",
            code: "park_threw",
            message: dispatchErrorMessage(e),
            envelope,
          };
        }
      }
      return {
        kind: "awaiting_confirmation",
        prompt: decision.prompt,
        ...frictionEnvelopeFields(envelopes),
      };
    }

    case "DEFER": {
      // Park EVERY deferred envelope, not just envelopes[0] (BKL-063; see
      // REQUEST_CONFIRMATION). deferUntil is computed ONCE so the whole plan
      // defers to the same instant. Single-envelope path is byte-identical.
      const envelopes = frictionEnvelopes(plan);
      const deferUntil = new Date(Date.now() + decision.timeoutMs).toISOString();
      for (const envelope of envelopes) {
        try {
          await capsule.session.parkDeferred(
            capsule.loadedSession.id,
            envelope,
            decision.signal,
            deferUntil,
            decision.timeoutMs,
          );
        } catch (e) {
          return {
            kind: "failed",
            phase: "DEFER",
            code: "park_threw",
            message: dispatchErrorMessage(e),
            envelope,
          };
        }
      }
      return {
        kind: "deferred",
        signal: decision.signal,
        timeoutMs: decision.timeoutMs,
        ...frictionEnvelopeFields(envelopes),
      };
    }

    case "ESCALATE": {
      // Queue EVERY envelope to the handoff, not just envelopes[0] (BKL-063): a
      // compound message escalated as a plan must hand the human ALL of it, or
      // envelopes[1..n] silently vanish. Order preserved. Single-envelope path
      // is byte-identical (one queue call, same args).
      const envelopes = frictionEnvelopes(plan);
      for (const envelope of envelopes) {
        try {
          await capsule.handoff.queue(envelope, decision.reason);
        } catch (e) {
          return {
            kind: "failed",
            phase: "ESCALATE",
            code: "handoff_threw",
            message: dispatchErrorMessage(e),
            envelope,
          };
        }
      }
      return {
        kind: "escalated",
        to: decision.to,
        reason: decision.reason,
        ...frictionEnvelopeFields(envelopes),
      };
    }
  }
}

/** User-safe fallback when the explainer itself throws while rendering a REFUSE. */
export const GENERIC_REFUSAL_TEXT =
  "I can't complete that request right now. Please try again or rephrase.";

/**
 * The envelopes a friction verb (REQUEST_CONFIRMATION / DEFER / ESCALATE) must
 * park or queue: EVERY envelope of the plan, in order, DEDUPED by `intentHash`
 * (BKL-063). Dedup prevents a double-park when a plan carries the identical
 * intent twice (the same intentHash keys one parked slot, and unpark is by
 * intentHash — two entries under one hash would be resumed/removed ambiguously).
 * An empty plan yields `[]` (no envelope to park — the verb still returns its
 * typed result), matching the pre-BKL-063 `pickEnvelope(...) === undefined` path.
 */
function frictionEnvelopes(plan: Plan): ReadonlyArray<IntentEnvelope> {
  const seen = new Set<string>();
  const out: IntentEnvelope[] = [];
  for (const envelope of plan.envelopes) {
    if (seen.has(envelope.intentHash)) continue;
    seen.add(envelope.intentHash);
    out.push(envelope);
  }
  return out;
}

/**
 * The `{ envelope?, envelopes? }` fields shared by the three friction results.
 * `envelope` is the FIRST parked/queued envelope (byte-compat: a single-envelope
 * friction verb returns exactly `{ envelope }`, as before). `envelopes` carries
 * the FULL ordered set and is present ONLY when more than one was parked, so the
 * single-envelope result shape is byte-identical.
 */
function frictionEnvelopeFields(envelopes: ReadonlyArray<IntentEnvelope>): {
  readonly envelope?: IntentEnvelope;
  readonly envelopes?: ReadonlyArray<IntentEnvelope>;
} {
  const first = envelopes[0];
  return {
    ...(first !== undefined ? { envelope: first } : {}),
    ...(envelopes.length > 1 ? { envelopes } : {}),
  };
}

/**
 * Resolve + execute ONE approved envelope. Returns `executed` on success or a typed
 * `failed` (tool_unresolved / tool_threw) — never throws, preserving the
 * dispatch-no-throw guarantee (RC-R1) for both the single- and multi-envelope EXECUTE
 * paths. This is the byte-equivalent of the pre-LogicReviewer-003 single-envelope body.
 */
async function executeEnvelope(
  envelope: IntentEnvelope,
  capsule: Capsule,
): Promise<DispatchResult> {
  const capability = inferCapability(envelope, capsule.tools);
  if (capability === undefined) {
    return {
      kind: "failed",
      phase: "EXECUTE",
      code: "tool_unresolved",
      message: unknownCapabilityMessage(envelope.kind),
      envelope,
    };
  }
  try {
    const tool = capsule.tools.resolveTool(capability, capsule);
    try {
      const result = await tool.execute(envelope.payload, capsule);
      return { kind: "executed", envelope, toolId: tool.id, result };
    } catch (e) {
      return {
        kind: "failed",
        phase: "EXECUTE",
        code: "tool_threw",
        message: dispatchErrorMessage(e),
        envelope,
      };
    }
  } catch (e) {
    return {
      kind: "failed",
      phase: "EXECUTE",
      code: "tool_unresolved",
      message: dispatchErrorMessage(e),
      envelope,
    };
  }
}

/**
 * The runtime maps `IntentEnvelope.kind` (the kernel's K) to the tool's
 * declared `capability`. By convention adopters set `intentKind ===
 * capability` for the simplest case; richer setups can intercept here
 * via `Capsule.tools` resolution. The base dispatcher does the direct
 * mapping and treats the registry as the source of truth.
 *
 * Safety (TypeReviewer-004): rather than blind-casting `envelope.kind as
 * CapabilityId`, we validate it is (a) a well-formed capability string and
 * (b) a capability the registry actually knows about, only THEN minting the
 * brand. A kind that is malformed or unregistered returns `undefined` — the
 * caller fails closed (a typed `tool_unresolved` failure) instead of
 * branding garbage and pushing it into `resolveTool`. For valid kinds the
 * resulting `CapabilityId` is identical to the old cast, so dispatch's
 * runtime behavior is unchanged.
 */
function inferCapability(
  envelope: IntentEnvelope,
  registry: ToolRegistry,
): CapabilityId | undefined {
  const candidate = asCapability(envelope.kind);
  if (candidate === undefined) {
    return undefined;
  }
  return registry.hasCapability(candidate) ? candidate : undefined;
}

/** Operator-facing message for a kind that did not resolve to a capability. */
function unknownCapabilityMessage(kind: unknown): string {
  return `No tool registered for capability "${String(kind)}" in this context.`;
}

function emptyEnvelope(): IntentEnvelope {
  return {
    version: 2,
    kind: "<noop>",
    payload: {},
    createdAt: "1970-01-01T00:00:00.000Z",
    nonce: "<noop>",
    actor: { principal: "system", sessionId: "<noop>" },
    taint: "SYSTEM",
    // `origin` became a required v2 field in @adjudicate/core 1.5.0 (the linked
    // kernel). This is a noop sentinel envelope (never adjudicated/dispatched);
    // the default origin keeps it well-formed without changing behavior.
    origin: DEFAULT_ORIGIN,
    intentHash: "<noop>",
  };
}

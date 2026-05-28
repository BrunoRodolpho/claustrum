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

import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type { Capsule } from "../capsule.js";
import type { Plan } from "../ports/planner.js";
import type { CapabilityId } from "../tools/types.js";

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
      readonly kind: "refused";
      readonly userText: string;
      readonly code: string;
      readonly refusalKind: string;
    }
  | {
      readonly kind: "awaiting_confirmation";
      readonly prompt: string;
      readonly envelope?: IntentEnvelope;
    }
  | {
      readonly kind: "deferred";
      readonly signal: string;
      readonly timeoutMs: number;
      readonly envelope?: IntentEnvelope;
    }
  | {
      readonly kind: "escalated";
      readonly to: "human" | "supervisor";
      readonly reason: string;
      readonly envelope?: IntentEnvelope;
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
      // The planned envelope drove this EXECUTE. For multi-envelope plans
      // the kernel returns one composite EXECUTE; we dispatch each envelope
      // in order. handleTurn-level callers usually have plan.envelopes.length === 1
      // for EXECUTE; multi-step is reserved for adjudicatePlan() variants.
      const envelope = pickEnvelope(plan);
      if (envelope === undefined) {
        // No envelope -> nothing to execute. Treat as a no-op dispatch.
        return {
          kind: "executed",
          envelope: emptyEnvelope(),
          toolId: "<noop>",
          result: undefined,
        };
      }
      const capability = inferCapability(envelope);
      // resolveTool throws on an unregistered capability (config drift,
      // role-filtered visibility, hot-deploy gap) and tool.execute carries no
      // no-throw guarantee (a refund tool can 5xx mid-call). A kernel-approved
      // EXECUTE the runtime can't honor must NOT crash the turn.
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

    case "REWRITE": {
      const envelope = decision.rewritten;
      const capability = inferCapability(envelope);
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
      const envelope = pickEnvelope(plan);
      if (envelope !== undefined) {
        // Park the envelope so the next-turn reply can be matched. If parking
        // fails the confirmation can never be honored, so surface a failure
        // rather than falsely telling the user "awaiting confirmation".
        try {
          await capsule.session.parkPendingConfirmation(
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
        ...(envelope !== undefined ? { envelope } : {}),
      };
    }

    case "DEFER": {
      const envelope = pickEnvelope(plan);
      if (envelope !== undefined) {
        const deferUntil = new Date(
          Date.now() + decision.timeoutMs,
        ).toISOString();
        try {
          await capsule.session.parkDeferred(
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
        ...(envelope !== undefined ? { envelope } : {}),
      };
    }

    case "ESCALATE": {
      const envelope = pickEnvelope(plan);
      if (envelope !== undefined) {
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
        ...(envelope !== undefined ? { envelope } : {}),
      };
    }
  }
}

/** User-safe fallback when the explainer itself throws while rendering a REFUSE. */
const GENERIC_REFUSAL_TEXT =
  "I can't complete that request right now. Please try again or rephrase.";

function pickEnvelope(plan: Plan): IntentEnvelope | undefined {
  return plan.envelopes.length > 0 ? plan.envelopes[0] : undefined;
}

/**
 * The runtime maps `IntentEnvelope.kind` (the kernel's K) to the tool's
 * declared `capability`. By convention adopters set `intentKind ===
 * capability` for the simplest case; richer setups can intercept here
 * via `Capsule.tools` resolution. The base dispatcher does the direct
 * mapping and treats the registry as the source of truth.
 */
function inferCapability(envelope: IntentEnvelope): CapabilityId {
  return envelope.kind as CapabilityId;
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
    intentHash: "<noop>",
  };
}

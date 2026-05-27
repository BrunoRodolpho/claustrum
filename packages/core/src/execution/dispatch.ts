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
    };

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
      const tool = capsule.tools.resolveTool(capability, capsule);
      const result = await tool.execute(envelope.payload, capsule);
      return {
        kind: "executed",
        envelope,
        toolId: tool.id,
        result,
      };
    }

    case "REWRITE": {
      const envelope = decision.rewritten;
      const capability = inferCapability(envelope);
      const tool = capsule.tools.resolveTool(capability, capsule);
      const result = await tool.execute(envelope.payload, capsule);
      return {
        kind: "rewritten_and_executed",
        envelope,
        toolId: tool.id,
        result,
        reason: decision.reason,
      };
    }

    case "REFUSE": {
      const userText = capsule.explainer.render(decision.refusal);
      return {
        kind: "refused",
        userText,
        code: decision.refusal.code,
        refusalKind: decision.refusal.kind,
      };
    }

    case "REQUEST_CONFIRMATION": {
      const envelope = pickEnvelope(plan);
      if (envelope !== undefined) {
        // Park the envelope so the next-turn reply can be matched.
        // The confirmation token is the envelope's intentHash by default.
        await capsule.session.parkPendingConfirmation(
          envelope,
          envelope.intentHash,
          decision.prompt,
        );
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
        await capsule.session.parkDeferred(
          envelope,
          decision.signal,
          deferUntil,
          decision.timeoutMs,
        );
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
        await capsule.handoff.queue(envelope, decision.reason);
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

/**
 * handleTurn — the 7-step cognitive loop.
 *
 * Verbatim from PART I §"The cognitive loop in actual code":
 *
 *   1. PERCEIVE   — normalize the inbound ChannelMessage
 *   2. UNDERSTAND — assemble CognitiveState from memory + retrieval + session
 *   3. PLAN       — planner proposes IntentEnvelope[]
 *   4. SUBMIT     — adjudicate (single) OR adjudicatePlan (multi-envelope)
 *   5. ACT        — dispatch on Decision (no throws; every variant handled)
 *   6. SYNTHESIZE — responder produces the user-facing reply
 *   7. OBSERVE    — memory.observe + telemetry.emitTurn
 *
 * Invariants enforced (asserted by tests/properties/):
 *   - adjudicate() called exactly once per turn
 *   - prompt manifest recorded with every LLM trace (via Responder)
 *   - EXECUTE -> exactly one tool invocation
 *   - REFUSE -> non-empty user-facing text via Explainer
 *   - LLM only sees `express_intent` (via the tool registry indirection)
 */

import type { AuditRecord, Decision } from "@adjudicate/core";
import type { Capsule } from "./capsule.js";
import { dispatchDecision, type DispatchResult } from "./execution/dispatch.js";
import type { ChannelMessage, RenderedResponse } from "./ports/channel.js";
import type { CognitiveState, Plan } from "./ports/planner.js";
import type { DraftResponse } from "./ports/responder.js";

export interface TurnResult {
  readonly response: RenderedResponse;
  readonly decision: Decision;
  /** Forward-only handle to the audit record (when adjudicator emits one). */
  readonly audit?: AuditRecord["auditHash"];
  readonly draft: DraftResponse;
  readonly acted: DispatchResult;
  readonly plan: Plan;
}

export async function handleTurn(
  capsule: Capsule,
  inbound: ChannelMessage,
): Promise<TurnResult> {
  const startedAt = Date.now();

  // 1. PERCEIVE — channel driver already normalized to ChannelMessage by
  //    the time the adopter calls handleTurn; we forward the inbound and
  //    derive a Perception-shaped value for downstream consumers.
  const perception = {
    text: inbound.text,
    channel: inbound.channel,
    ...(inbound.externalId !== undefined
      ? { externalId: inbound.externalId }
      : {}),
    receivedAt: inbound.receivedAt,
    ...(inbound.locale !== undefined ? { locale: inbound.locale } : {}),
    ...(inbound.attachments !== undefined
      ? { attachments: inbound.attachments }
      : {}),
  };

  // 2. UNDERSTAND — assemble cognition from memory + grounding + session.
  const [memory, retrieval] = await Promise.all([
    capsule.memory.recall(capsule.customerId, perception),
    capsule.grounding.retrieve(perception),
  ]);
  const session = capsule.loadedSession;
  const cognition: CognitiveState = {
    perception,
    memory,
    retrieval,
    workingMemory: session.workingMemory.summary,
    tenantId: capsule.tenant.tenantId,
    locale: capsule.locale,
    conversationId: capsule.conversationId,
    turnId: capsule.turnId,
  };

  // 3. PLAN — propose envelopes. NO mutations yet.
  const plan = await capsule.planner.propose(cognition);

  // 4. SUBMIT — adjudicate exactly once per turn.
  //    Single envelope -> adjudicate(); zero or multiple envelopes ->
  //    adjudicatePlan(). An empty plan is NOT short-circuited: it is
  //    passed to adjudicatePlan([]) so the "adjudicate called once per
  //    turn" invariant holds unconditionally. The Adjudicator port
  //    (and the StubAdjudicator test double) treat an empty envelope
  //    array as "no mutation proposed" and return EXECUTE with an empty
  //    basis, allowing downstream code to synthesize a response.
  let decision: Decision;
  const firstEnvelope = plan.envelopes[0];
  if (plan.envelopes.length === 1 && firstEnvelope !== undefined) {
    decision = await capsule.adjudicate(firstEnvelope);
  } else {
    decision = await capsule.adjudicatePlan(plan.envelopes);
  }

  // 5. ACT — dispatch the decision.
  const acted = await dispatchDecision(decision, plan, capsule);

  // 6. SYNTHESIZE — produce the user-facing reply.
  const draft = await capsule.responder.respond({
    cognition,
    decision,
    plan,
    acted,
    ...(capsule.tenant.voice !== undefined
      ? { voice: capsule.tenant.voice }
      : {}),
  });

  const response: RenderedResponse = {
    channel: capsule.channel,
    customerId: capsule.customerId,
    conversationId: capsule.conversationId,
    text: draft.text,
    ...(draft.artifacts !== undefined ? { artifacts: draft.artifacts } : {}),
    meta: buildResponseMeta(acted),
  };

  const durationMs = Date.now() - startedAt;
  const intentHash = plan.envelopes[0]?.intentHash;

  // 7. OBSERVE — fire-and-forget telemetry + memory observation.
  await Promise.all([
    capsule.memory.observe(capsule.customerId, {
      turnId: capsule.turnId,
      conversationId: capsule.conversationId,
      perception,
      userText: inbound.text,
      responseText: response.text,
      decisionKind: decision.kind,
      ...(intentHash !== undefined ? { intentHash } : {}),
      at: new Date().toISOString(),
    }),
    capsule.telemetry.emitTurn({
      turnId: capsule.turnId,
      conversationId: capsule.conversationId,
      customerId: capsule.customerId,
      tenantId: capsule.tenant.tenantId,
      channel: capsule.channel,
      inboundText: inbound.text,
      responseText: response.text,
      decisionKind: decision.kind,
      ...(intentHash !== undefined ? { intentHash } : {}),
      durationMs,
      at: new Date().toISOString(),
    }),
  ]);

  return {
    response,
    decision,
    draft,
    acted,
    plan,
  };
}

function buildResponseMeta(
  acted: DispatchResult,
): RenderedResponse["meta"] | undefined {
  switch (acted.kind) {
    case "awaiting_confirmation":
      return { awaitingConfirmation: true };
    case "deferred":
      return { deferred: true };
    case "escalated":
      return { escalated: true };
    case "failed":
      return { failed: true };
    default:
      return undefined;
  }
}

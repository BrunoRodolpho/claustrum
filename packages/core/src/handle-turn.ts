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

import type {
  AuditRecord,
  ClaimsKernelResult,
  Decision,
  IntentEnvelope,
} from "@adjudicate/core";
import type { Capsule } from "./capsule.js";
import type { SystemState } from "./ports/adjudicator.js";
import { runClaimsValidate, runInvestigate } from "./claims-loop/index.js";
import {
  dispatchDecision,
  GENERIC_REFUSAL_TEXT,
  type DispatchResult,
} from "./execution/dispatch.js";
import { TELEMETRY_SCHEMA_VERSION } from "./telemetry-bounds.js";
import type { ChannelMessage, RenderedResponse } from "./ports/channel.js";
import type { CognitiveState, Plan } from "./ports/planner.js";
import type { DraftResponse, OutputContext } from "./ports/responder.js";
import type { DeferredEnvelope } from "./ports/session.js";

export interface TurnResult {
  readonly response: RenderedResponse;
  readonly decision: Decision;
  /** Forward-only handle to the audit record (when adjudicator emits one). */
  readonly audit?: AuditRecord["auditHash"];
  readonly draft: DraftResponse;
  readonly acted: DispatchResult;
  readonly plan: Plan;
  /**
   * The CLAIMS-VALIDATE result (SDD §M / §Q.6; v1.1 §4) — the validated +
   * consistent renderable claim set + the turn terminal
   * (`RENDER | UNKNOWN | ESCALATE | CLARIFY`), produced by running the published
   * Claims Kernel (P1 ∘ P2) over the per-turn Evidence Ledger that INVESTIGATE
   * populated. Present ONLY when the claim pipeline is wired (an `investigator`
   * + `claimPlanner` + `claimsKernel` deps); `undefined` on the legacy loop.
   * The renderer-from-claims (downstream, ibatexas — §Q.7) renders FROM this,
   * never re-deriving validation.
   */
  readonly claims?: ClaimsKernelResult;
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

  // 2b. RESUME (P0-B / LogicReviewer-004) — if this inbound resolves a parked
  //     confirmation or a now-due deferral, RE-ADJUDICATE the parked envelope
  //     and act on that fresh Decision. The resume path NEVER dispatches the
  //     parked envelope directly on confirm: every resumed EXECUTE side-effect
  //     is backed by a fresh audited Decision (the audit invariant), and a
  //     confirmation that arrives after the state changed is re-evaluated
  //     against current state and can REFUSE (money-safety). When nothing is
  //     resumed, the normal PLAN→SUBMIT below runs byte-equivalently.
  const resumed = await resolveResume(capsule, inbound);

  let decision: Decision;
  let plan: Plan;
  if (resumed !== null) {
    decision = resumed.decision;
    plan = { envelopes: [resumed.envelope] };
  } else {
    // 3. PLAN — propose envelopes. NO mutations yet.
    plan = await capsule.planner.propose(cognition);

    // 3b. RESOLVE (optional) — turn the planner's (possibly natural-language)
    //     envelopes into RESOLVED envelopes + a per-envelope assembled
    //     SystemState, BEFORE adjudication. The resolved envelopes replace
    //     plan.envelopes so they are what gets adjudicated, dispatched, AND
    //     audited (audited == executed). Read-only. When no resolver is wired
    //     the plan is adjudicated as-is against resolution.state (legacy).
    let perEnvelopeStates: ReadonlyArray<SystemState> | undefined;
    if (capsule.resolver !== undefined && plan.envelopes.length > 0) {
      const resolved = await capsule.resolver.resolve({
        plan,
        cognition,
        customerId: capsule.customerId,
        channel: capsule.channel,
      });
      plan = { ...plan, envelopes: resolved.map((r) => r.envelope) };
      perEnvelopeStates = resolved.map((r) => r.state);
    }

    // 4. SUBMIT — adjudicate exactly once per turn.
    //    Single envelope -> adjudicate(); zero or multiple envelopes ->
    //    adjudicatePlan(). An empty plan is NOT short-circuited: it is
    //    passed to adjudicatePlan([]) so the "adjudicate called once per
    //    turn" invariant holds unconditionally. The Adjudicator port
    //    (and the StubAdjudicator test double) treat an empty envelope
    //    array as "no mutation proposed" and return EXECUTE with an empty
    //    basis, allowing downstream code to synthesize a response.
    const firstEnvelope = plan.envelopes[0];
    if (plan.envelopes.length === 1 && firstEnvelope !== undefined) {
      decision = await capsule.adjudicate(firstEnvelope, perEnvelopeStates?.[0]);
    } else {
      decision = await capsule.adjudicatePlan(plan.envelopes, perEnvelopeStates);
    }
  }

  // 4b. INVESTIGATE (optional, SDD §M / §Q.6; v1.1 §7; Inv 7) — gather this
  //     turn's evidence INTO a fresh per-turn Evidence Ledger from the resolved
  //     reads/context. The ledger is a STRUCTURAL part of the loop (built here,
  //     not embedded in the responder — §M); the SAME instance is threaded into
  //     CLAIMS-VALIDATE below. `plan` here is the resolved/resumed plan, so the
  //     investigator gathers evidence for the envelopes that were adjudicated.
  //     When no investigator is wired this is a no-op (`ledger` stays undefined)
  //     and the claim pipeline does not run — the legacy loop is byte-equivalent.
  const ledger = await runInvestigate(capsule, cognition, plan);

  // 4c. CLAIMS-VALIDATE (optional, SDD §M / §Q.6; v1.1 §4, §8; §F) — the
  //     deterministic post-planner wall. Runs the published Claims Kernel
  //     (`runClaimsKernel` = P1 soundness ∘ P2 consistency) over the THREADED
  //     ledger + the planner's typed candidate claims → the renderable
  //     VALIDATED+consistent set + the turn terminal. The ledger is read-only
  //     INPUT here (one-directional topology — §F); this stage never writes back
  //     into it. `undefined` unless the full pipeline is wired. This is NOT a
  //     mutation verb — it does not call `adjudicate()`, so the once-per-turn
  //     invariant (Hard Rule #3) is preserved.
  const claims = await runClaimsValidate(capsule, cognition, plan, ledger);

  // 5. ACT — dispatch the decision.
  const acted = await dispatchDecision(decision, plan, capsule);

  // 5b. RESUME cleanup — a resolved parked envelope (whether it EXECUTEd or
  //     REFUSEd on re-adjudication) is unparked so a later inbound cannot match
  //     it again. unpark removes from BOTH pending-confirmations and deferred.
  if (resumed !== null) {
    await capsule.session.unpark(
      capsule.loadedSession.id,
      resumed.envelope.intentHash,
    );
  }

  // 6. SYNTHESIZE — produce the user-facing reply.
  let draft = await capsule.responder.respond({
    cognition,
    decision,
    plan,
    acted,
    ...(capsule.tenant.voice !== undefined
      ? { voice: capsule.tenant.voice }
      : {}),
  });

  // 6a. RENDER-FROM-CLAIMS (optional, SDD §B / §J.6 / §O#3 / §O#15 / §Q.7) — the
  //     "claims-not-prose" thesis at the loop level. When the CLAIMS-VALIDATE
  //     stage produced a result AND a `claimsRenderer` is wired, the reply TEXT
  //     is rendered DETERMINISTICALLY from the validated claims + turn terminal —
  //     superseding the model draft's text (no model-authored customer prose).
  //     Artifacts / usage still come from the draft, and the rendered text still
  //     passes the OUTPUT FIREWALL below (defense in depth). Byte-identical when
  //     unwired (no claims result, or no renderer) — the legacy reply stands.
  //     This is NOT a mutation verb (no `adjudicate()` call), so the once-per-turn
  //     invariant (Hard Rule #3) is preserved.
  //
  //     RENDER IS SOLE AUTHOR ON THE RENDERED PATH (Plan 1 Phase 3 / F6). Once the
  //     pipeline produced a `claims` result and a renderer is wired, the model
  //     responder draft MUST NOT reach the customer — keeping it would re-admit
  //     model-authored prose as a confident fact (§O#3). So the rendered text
  //     supersedes the draft UNCONDITIONALLY; a degenerate-EMPTY render (no
  //     renderable claim) falls back to a proposition-free SAFE TERMINAL
  //     (`GENERIC_REFUSAL_TEXT`), NEVER the model draft and NEVER silence. The
  //     adopter's renderer is expected to emit a non-empty proposition-free safe
  //     template (UNKNOWN/ESCALATE/CLARIFY) for any non-RENDER / degenerate case;
  //     this fail-safe is the loop-level backstop if it does not. The request
  //     surface is threaded so the renderer can run the §O#15 required-claim
  //     completeness gate (F2).
  if (claims !== undefined && capsule.claimsRenderer !== undefined) {
    const renderedFromClaims = capsule.claimsRenderer.render(claims, {
      requestText: perception.text,
    });
    draft = {
      ...draft,
      text:
        renderedFromClaims.text.trim() !== ""
          ? renderedFromClaims.text
          : GENERIC_REFUSAL_TEXT,
    };
  }

  // 6b. OUTPUT FIREWALL (optional, F1) — gate the draft through the kernel when
  //     the adopter wired `adjudicateOutput` AND the tenant flag is on. This is
  //     an OUTPUT verb: it does NOT call `adjudicate()`, so the once-per-turn
  //     invariant is preserved. Fail CLOSED — on a non-EXECUTE verdict OR a
  //     throw, the un-vetted draft is NEVER emitted; a refusal is rendered
  //     instead. (The adopter's impl carries the PII/content guard, e.g.
  //     `createDataClassificationGuard` over the response text.)
  let responseText = draft.text;
  // True once the firewall blocks the draft — used to ALSO drop artifacts, so a
  // blocked turn can't leak via a channel artifact what it scrubbed from text.
  let outputBlocked = false;
  if (
    capsule.tenant.flags?.enable_output_adjudication === true &&
    capsule.adjudicator.adjudicateOutput !== undefined
  ) {
    try {
      const outputContext: OutputContext = {
        cognition,
        decision,
        plan,
        tenantId: capsule.tenant.tenantId,
        turnId: capsule.turnId,
      };
      const outDecision = await capsule.adjudicator.adjudicateOutput(
        draft,
        outputContext,
      );
      if (outDecision.kind === "EXECUTE") {
        // Allowed unchanged.
      } else if (outDecision.kind === "REFUSE") {
        const rendered = capsule.explainer.render(outDecision.refusal);
        responseText = rendered.length > 0 ? rendered : GENERIC_REFUSAL_TEXT;
        outputBlocked = true;
      } else {
        // Any other verdict on an OUTPUT is not a safe "allow" (the kernel's
        // REWRITE carries an envelope, not response text; DEFER/ESCALATE/
        // CONFIRM are nonsensical here) — block fail-safe.
        responseText = GENERIC_REFUSAL_TEXT;
        outputBlocked = true;
      }
    } catch {
      // Firewall threw → never leak the un-vetted draft.
      responseText = GENERIC_REFUSAL_TEXT;
      outputBlocked = true;
    }
  }

  const response: RenderedResponse = {
    channel: capsule.channel,
    customerId: capsule.customerId,
    conversationId: capsule.conversationId,
    text: responseText,
    ...(draft.artifacts !== undefined && !outputBlocked
      ? { artifacts: draft.artifacts }
      : {}),
    meta: buildResponseMeta(acted),
  };

  const durationMs = Date.now() - startedAt;
  const intentHash = plan.envelopes[0]?.intentHash;

  // Per-turn token usage = planning + synthesis model calls (cost accounting,
  // F4). Summed onto the TurnRecord (the once-per-turn seam that also carries
  // customerId) so an adopter can meter per-session spend off a single call.
  // Undefined when neither phase reported usage — keep the fields off the record.
  const inputTokens =
    (plan.usage?.inputTokens ?? 0) + (draft.usage?.inputTokens ?? 0);
  const outputTokens =
    (plan.usage?.outputTokens ?? 0) + (draft.usage?.outputTokens ?? 0);
  const usageFields =
    inputTokens > 0 || outputTokens > 0 ? { inputTokens, outputTokens } : {};

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
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      turnId: capsule.turnId,
      conversationId: capsule.conversationId,
      customerId: capsule.customerId,
      tenantId: capsule.tenant.tenantId,
      channel: capsule.channel,
      inboundText: inbound.text,
      responseText: response.text,
      decisionKind: decision.kind,
      ...(intentHash !== undefined ? { intentHash } : {}),
      ...usageFields,
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
    // Present only when the claim pipeline is wired; omitted on the legacy loop
    // so an adopter without the pipeline sees no `claims` key (not `undefined`).
    ...(claims !== undefined ? { claims } : {}),
  };
}

/**
 * Default re-park window (ms) for a confirmation the user postpones ("yes,
 * tomorrow"). Precise natural-language→deferUntil mapping is a documented
 * follow-up; the channel adapter detects the phrase, the conductor parks with
 * a safe default until that lands.
 */
const DEFAULT_DEFER_MS = 24 * 60 * 60 * 1000;

interface ResumedTurn {
  readonly decision: Decision;
  readonly envelope: IntentEnvelope;
}

/**
 * Detect whether `inbound` resumes a parked envelope and, if so, RE-ADJUDICATE
 * it. Returns the fresh `{ decision, envelope }` to act on, or `null` to run
 * the normal cognitive loop.
 *
 * Two resumption triggers:
 *  1. A channel-matched reply to a parked REQUEST_CONFIRMATION
 *     (`ChannelDriver.matchToParked`): `confirm` re-adjudicates WITH a
 *     confirmation receipt; `deny` abandons (unpark) and falls through;
 *     `defer` re-parks as deferred and falls through.
 *  2. A deferred envelope whose `deferUntil` has passed (channel-agnostic):
 *     re-adjudicate WITHOUT a receipt — EXECUTE only if the kernel's guards
 *     now pass against fresh state.
 *
 * Safe degradation: when the adjudicator does not implement the optional
 * `resume` verb (`capsule.resume` undefined), this returns `null` — we never
 * dispatch a parked envelope without re-adjudication.
 */
async function resolveResume(
  capsule: Capsule,
  inbound: ChannelMessage,
): Promise<ResumedTurn | null> {
  if (capsule.resume === undefined) return null;
  const session = capsule.loadedSession;
  const driver = capsule.channels[capsule.channel];

  // 1. Channel-specific confirmation-reply matching.
  const match = driver?.matchToParked(inbound, session) ?? null;
  if (match !== null) {
    const env = match.parked.envelope;
    if (match.userResolution === "confirm") {
      const decision = await capsule.resume(env, {
        intentHash: env.intentHash,
        at: inbound.receivedAt,
        originalAt: match.parked.parkedAt,
        ...(match.parked.confirmationToken
          ? { token: match.parked.confirmationToken }
          : {}),
      });
      return { decision, envelope: env };
    }
    if (match.userResolution === "deny") {
      // Declined → abandon the parked envelope. No mutation, nothing to
      // adjudicate/audit; the "no" reply runs the normal loop below.
      await capsule.session.unpark(session.id, env.intentHash);
      return null;
    }
    // defer → re-park as deferred with a safe default window; the reply runs
    // the normal loop. The deferred envelope resumes via trigger (2) later.
    await capsule.session.unpark(session.id, env.intentHash);
    await capsule.session.parkDeferred(
      session.id,
      env,
      match.deferPhrase ?? "later",
      new Date(Date.parse(inbound.receivedAt) + DEFAULT_DEFER_MS).toISOString(),
      DEFAULT_DEFER_MS,
    );
    return null;
  }

  // 2. A deferred envelope whose condition (deferUntil) is now satisfied.
  const due = pickDueDeferred(session.deferredEnvelopes, inbound.receivedAt);
  if (due !== null) {
    // No receipt: a plain re-adjudication. The kernel EXECUTEs only if its
    // guards now pass against fresh state (the deferral condition is met).
    const decision = await capsule.resume(due.envelope);
    return { decision, envelope: due.envelope };
  }

  return null;
}

/**
 * The first deferred envelope whose `deferUntil` is at or before `nowIso`.
 * A malformed/absent `deferUntil` is treated as NOT due (fail-safe: never
 * resume early). Returns `null` when none are due.
 */
function pickDueDeferred(
  deferred: ReadonlyArray<DeferredEnvelope>,
  nowIso: string,
): DeferredEnvelope | null {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;
  for (const d of deferred) {
    const until = Date.parse(d.deferUntil);
    if (Number.isFinite(until) && until <= now) return d;
  }
  return null;
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

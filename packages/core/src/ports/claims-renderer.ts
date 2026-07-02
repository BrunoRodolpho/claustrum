/**
 * ClaimsRendererPort — renders the customer-facing reply FROM the validated
 * claims (SDD §B / §J.6 / §O#3 / §Q.7; v1.1 §3). This is the seam that closes the
 * "claims-not-prose" thesis at the loop level: when the claim pipeline produced a
 * result, the reply TEXT is rendered DETERMINISTICALLY from the kernel's
 * renderable VALIDATED+consistent set + turn terminal — NOT authored by the
 * probabilistic responder model.
 *
 * Optional + adopter-supplied (ibatexas wires its `renderer-from-claims`): when
 * absent, `handleTurn` keeps the legacy model-responder reply (byte-identical).
 * When wired AND the CLAIMS-VALIDATE stage produced a `ClaimsKernelResult`, the
 * loop SUPERSEDES the draft's TEXT with this renderer's output (artifacts / usage
 * still come from the draft). The rendered text still passes the OUTPUT FIREWALL
 * (defense in depth) before egress.
 *
 * RENDER IS SOLE AUTHOR ON THE RENDERED PATH (Plan 1 Phase 3 / F6): once wired and
 * a claims result exists, the model responder draft NEVER reaches the customer —
 * the supersession is UNCONDITIONAL. A degenerate/EMPTY render does NOT fall back
 * to the operational responder draft; the loop emits a proposition-free SAFE
 * TERMINAL instead (never model-authored prose, never silence). The renderer is
 * expected to emit its own non-empty proposition-free safe template for any
 * non-RENDER terminal; the safe-terminal fallback is only the loop-level backstop.
 *
 * The renderer is a PURE deterministic template-filler in the adopter (no model,
 * no IO); this port carries only the seam contract. It consumes the published
 * `@adjudicate/core` `ClaimsKernelResult` — the SAME shape CLAIMS-VALIDATE emits
 * (the dependency arrow stays `adjudicate → claustrum → ibatexas`).
 */

import type { ClaimsKernelResult } from "@adjudicate/core";

/** The deterministic reply rendered from a `ClaimsKernelResult`. */
export interface ClaimsRenderResult {
  /** The customer-facing pt-BR reply text (rendered, not model-authored). */
  readonly text: string;
}

/**
 * The per-turn REQUEST context the renderer may use for the §O#15 required-claim
 * completeness gate (Plan 1 Phase 3 / F2). The kernel `ClaimsKernelResult` carries
 * the per-claim verdicts but NOT the original request, so a renderer that must
 * decide "was every REQUIRED companion of THIS request validated?" needs the
 * request surface. Optional + structural — the loop supplies it; a renderer that
 * does no completeness gating ignores it (byte-identical). The renderer stays a
 * PURE deterministic function of `(claims, context)`; this carries no clock/RNG.
 */
export interface ClaimsRenderContext {
  /** The raw inbound request text (the §O#8 span-segmenter input the adopter
   *  classifies into span-classes for the §O#15 required-claim decomposer). */
  readonly requestText?: string;
  /**
   * The resources ACTIVE for this turn's authenticated customer (the #8
   * decomposer ownership signal): which owner-scoped resources (e.g. the active
   * order / pending payment) the required-claim decomposer may demand companions
   * for. Derived by the adopter's {@link ActiveResourcesForTurn} seam from the
   * threaded Evidence Ledger + the AUTHENTICATED customerId — NEVER from
   * session/model-supplied ids ("no owner" ≠ "any owner"; IDOR stays closed).
   * Optional + structural: absent (seam unwired or no ledger) the renderer
   * behaves exactly as before (byte-identical). Plain data — the context stays
   * a PURE input (no clock/RNG).
   */
  readonly activeResources?: readonly ActiveResourceRef[];
}

/**
 * A single active-resource reference threaded to the renderer. `kind` is the
 * ADOPTER's resource vocabulary (e.g. "order" / "payment") — claustrum assigns
 * it no meaning; the pair only parameterizes the adopter's own decomposer.
 */
export interface ActiveResourceRef {
  readonly kind: string;
  readonly id: string;
}

/**
 * Render the reply from this turn's `ClaimsKernelResult` (the renderable set +
 * terminal). MUST be PURE/deterministic — same `(result, context)` ⟹ same text —
 * and assert NO domain fact that is not backed by a VALIDATED claim (Inv 6); a
 * non-RENDER terminal renders a proposition-free safe template (the adopter
 * enforces this). `context` (optional) carries the per-turn request surface for
 * the §O#15 required-claim completeness gate (F2); a renderer that does not gate
 * may ignore it.
 */
export interface ClaimsRendererPort {
  render(
    claims: ClaimsKernelResult,
    context?: ClaimsRenderContext,
  ): ClaimsRenderResult;
}

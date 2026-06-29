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

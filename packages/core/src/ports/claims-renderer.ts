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
 * Render the reply from this turn's `ClaimsKernelResult` (the renderable set +
 * terminal). MUST be PURE/deterministic — same result ⟹ same text — and assert
 * NO domain fact that is not backed by a VALIDATED claim (Inv 6); a non-RENDER
 * terminal renders a proposition-free safe template (the adopter enforces this).
 */
export interface ClaimsRendererPort {
  render(claims: ClaimsKernelResult): ClaimsRenderResult;
}

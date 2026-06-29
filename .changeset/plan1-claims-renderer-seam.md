---
"@claustrum/core": minor
---

Render-from-claims seam (Plan 1 Phase 3 / SDD §B · §J.6 · §O#3 · §Q.7): the
cognitive loop can now render the customer-facing reply DETERMINISTICALLY from the
validated claims — the "claims-not-prose" thesis at the loop level.

- New optional port `ClaimsRendererPort` (`render(claims: ClaimsKernelResult) →
  { text }`) + `ClaimsRenderResult`, exported from the barrel. The deterministic
  template-filler itself lives DOWNSTREAM (ibatexas `renderer-from-claims`); this
  is the seam contract only.
- New optional `Capsule.claimsRenderer` + `ConductorOptions.claimsRenderer`,
  threaded straight through `createConductor` (like the other claims seams).
- `handleTurn` new stage 6a (RENDER-FROM-CLAIMS): when CLAIMS-VALIDATE produced a
  `ClaimsKernelResult` AND `claimsRenderer` is wired, the reply TEXT is rendered
  from the claims, SUPERSEDING the model draft's text (artifacts/usage still come
  from the draft; the rendered text still passes the OUTPUT FIREWALL). Not a
  mutation verb — no `adjudicate()` call, so the once-per-turn invariant holds.

ADDITIVE + BYTE-IDENTICAL when unwired: with no `claimsRenderer` (or no claims
result), the legacy model-responder reply stands unchanged. The frozen ports are
extended, never broken.

---
"@claustrum/core": minor
---

Thread the #8 decomposer ownership signal to the claims renderer: new optional
`ActiveResourcesForTurn` seam on the Capsule/Conductor (mirroring
`ClaimsKernelDepsForTurn`) derives the turn's active owner-scoped resources from
the threaded Evidence Ledger + the AUTHENTICATED customerId — never
session/model ids — and `handleTurn` passes the result to the renderer as the
new `ClaimsRenderContext.activeResources` (`ActiveResourceRef[]`). All additive
and optional: unwired conductors/renderers are byte-identical. This is the
pre-flag-flip gate for the adopter-side §O#15 required-claim decomposer's
ownership companions (BKL-004).

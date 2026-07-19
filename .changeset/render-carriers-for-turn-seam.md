---
"@claustrum/core": minor
---

Add the `RenderCarriersForTurn` populating seam so the adopter can SET the two
domain-owned `ClaimsRenderContext` carriers, mirroring the `ActiveResourcesForTurn`
precedent EXACTLY.

`ClaimsRenderContext.turnId` is claustrum-native (threaded directly by
`handleTurn`), but `resolvedQueryDate` (BKL-152) and `disambiguationCandidates`
(BKL-170) are ADOPTER-computed domain values (ibatexas `resolveQueriedScheduleDate`
+ the read executor's disambiguation) — without a populating seam those two
carriers were unreachable and the type widening was hollow.

This adds ONE non-breaking optional per-turn deriver, threaded at every
`activeResourcesForTurn` touchpoint in lockstep (ConductorOptions → Capsule →
`handleTurn` render context spread → barrel export):

```ts
export type RenderCarriersForTurn = (args: {
  ledger: EvidenceLedger;      // this turn's read-only Evidence Ledger
  customerId: string;          // the AUTHENTICATED customer
  requestText: string;         // the inbound request text
}) => Pick<ClaimsRenderContext, "resolvedQueryDate" | "disambiguationCandidates">;
```

At RENDER-FROM-CLAIMS the loop invokes `capsule.renderCarriersForTurn({ ledger,
customerId, requestText })` (only when a ledger exists) and SPREADS the result
into the `ClaimsRenderContext` handed to the renderer — pure carrier passthrough,
no claustrum logic, the adopter owns the derivation. Return only the carriers you
resolved; omit a field and it stays absent.

NON-BREAKING: the seam is optional and derives ONLY from the threaded ledger +
the AUTHENTICATED customerId + request text (never session/model ids — IDOR stays
closed). An adopter that does not wire it gets neither carrier — byte-identical.
`RenderCarriersForTurn` is barrel-exported from `@claustrum/core` and threaded
through the Conductor like the other claims seams.

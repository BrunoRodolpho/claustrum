---
"@claustrum/core": minor
---

claimsRenderPrecedence seam — adopter decides render-vs-draft (BKL-155/153).

RENDER-FROM-CLAIMS (`handleTurn` step 6a) overwrote the responder draft's text
with the claims render UNCONDITIONALLY whenever the claim pipeline produced any
result. That is correct for a factual answer turn, but the adopter (ibatexas)
live-proved two turn shapes it clobbers:

- a kernel REQUEST_CONFIRMATION prompt (e.g. a paid-cancel confirm) — the
  render replaced the confirmation text, making the confirm invisible; and
- a legitimate conversational reply on a pure STATEMENT turn (a "thank you") —
  the render replaced it with a claims non-sequitur.

The route could not intervene: the render adapter returns only `{ text }`, and
by the time the route saw the reply the draft had already been overwritten. A
CORE seam is required.

This adds ONE non-breaking optional Capsule port:

```ts
export type ClaimsRenderPrecedence = (ctx: {
  decision: Decision;
  plan: Plan;
  claims: ClaimsKernelResult;
  requestText: string;
}) => "render" | "keep_draft";
```

`handleTurn` still calls `claimsRenderer.render(...)` UNCONDITIONALLY (its
BKL-111 terminal telemetry + observability side-effects fire exactly as before);
only the OVERWRITE of `draft` is now gated on
`capsule.claimsRenderPrecedence?.({ decision, plan, claims, requestText }) ??
"render"`. On `"keep_draft"` the responder draft is left untouched and still
passes the OUTPUT FIREWALL (step 6b). Core holds NO policy — it only asks the
port and defaults to `"render"`.

NON-BREAKING: the port is optional and consulted only on the rendered path (a
claims result exists AND a `claimsRenderer` is wired). An adopter that does not
wire it gets `"render"` — byte-identical to 0.6.0. The new type is barrel-
exported from `@claustrum/core` and threaded through the Conductor like the
other claims seams.

---
"@claustrum/core": minor
---

Widen `ClaimsRenderContext` with three additive optional carrier fields for the
adopter's claims renderer (ibatexas riders BKL-117 / BKL-152 / BKL-170):

- `turnId?: string` — the loop's own per-turn id, the join key the adopter uses
  to correlate a rendered `claims.terminal` back to its `turn_trace` row
  (BKL-117). This one is claustrum-native, so `handleTurn` threads it straight
  into the render context (like `requestText`) — a pure carrier, no logic.
- `resolvedQueryDate?: string` — an ISO `YYYY-MM-DD`, the deterministically
  resolved queried schedule date the adopter's §O#15 required-claim decomposer
  reads to suppress the exact `weekday == today` decomposition (BKL-152).
- `disambiguationCandidates?: readonly { kind; id; label }[]` — the concrete
  options the adopter's renderer offers back on a CLARIFY-with-candidates
  terminal (BKL-170).

All three are optional + structural, so a context that omits them is byte-
identical to today. `resolvedQueryDate` and `disambiguationCandidates` are
ADOPTER-owned domain values — claustrum assigns them no meaning and has no
native source, so it only publishes the type surface (the adopter threads them
from its resolver output); no derivation seam is added and no claustrum behavior
changes. Mirrors the additive-optional discipline of `activeResources`.

---
"@claustrum/core": minor
---

ClaimPlannerPort carries a forced turn terminal (ESCALATE/CLARIFY) — BKL-077.

`ClaimPlannerPort.propose` may now return either the legacy
`ReadonlyArray<CandidateClaim>` OR the widened `{ candidates, forcedTerminal? }`
(`ClaimPlannerProposal`), where `forcedTerminal` is a `ClaimPlannerForcedTerminal`
= `"ESCALATE" | "CLARIFY"`. This is a NON-BREAKING widening: every existing
adopter planner (and test double) returns the bare array and is byte-identical
after the change — the single CLAIMS-VALIDATE call seam normalizes it via
`normalizeClaimPlannerResult` to `{ candidates, forcedTerminal: undefined }`, so
no terminal is ever forced.

A planner that computes a terminal the deterministic P1∘P2 gates cannot see — a
SAFETY `ESCALATE` (allergen / unrecognized health marker, SDD §O#9) or an
AMBIGUITY `CLARIFY` (a customer with 3 payments asking "is my payment done?" →
"which order?", SDD §J.8) — can now surface it. Before this change the terminal
was DISCARDED: the ESCALATE silently became `UNKNOWN`, and a `CLARIFY` with no
bindable candidate fell through to the legacy responder as a generic deflection
(both live-proven in ibatexas).

`runClaimsValidate` HONORS the forced terminal via the spec precedence
(`resolveTurnTerminal`, now exported):
- forced `ESCALATE` OUTRANKS everything, including a would-be `RENDER` (SDD §O#9
  / §J.7 fail-closed) — and suppresses the renderable set so the safety route
  cannot leak the answer it overrode;
- forced `CLARIFY` YIELDS to a complete `RENDER` (never withhold a validated
  answer) and to a kernel `ESCALATE` (monotonic escalation), but OVERRIDES an
  honest-ignorance `UNKNOWN`;
- a forced terminal is honored even when `candidates` is EMPTY (the 3-payments
  case), so the turn no longer falls through to a generic deflection.

`perClaim` and the `consistency` sub-record are always preserved (P4
completeness — every candidate keeps its explicit verdict). New barrel exports:
`ClaimPlannerProposal`, `ClaimPlannerResult`, `ClaimPlannerForcedTerminal`,
`normalizeClaimPlannerResult`, `resolveTurnTerminal`.

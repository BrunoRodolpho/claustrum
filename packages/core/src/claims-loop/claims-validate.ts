/**
 * CLAIMS-VALIDATE — the deterministic post-planner wall (SDD §M / §Q.6; v1.1 §4,
 * §8; SDD §F).
 *
 * Runs the published Claims Kernel (`runClaimsKernel`, Q5 = P1 soundness ∘ P2
 * consistency) over the THREADED Evidence Ledger + the planner's candidate claims
 * → the renderable VALIDATED+consistent claim set + the turn terminal
 * (`RENDER | UNKNOWN | ESCALATE | CLARIFY`). This is the deterministic wall that
 * bounds the probabilistic planner (v1.1 §8): a mis-framed candidate degrades to
 * `UNKNOWN`/`ESCALATE`/`CLARIFY` rather than reaching the customer as a confident
 * wrong assertion.
 *
 * Topology (SDD §F — asymmetric, one-directional): the Ledger is read-only INPUT
 * here. The kernel CONSUMES it; this stage never writes back into it and nothing
 * flows Claims → Ledger → Read. claustrum imports `runClaimsKernel` (and the
 * verdict/terminal types) FROM the published `@adjudicate/core` — never the
 * reverse (the dependency arrow is `adjudicate → claustrum → ibatexas`).
 *
 * The deps (Q3 `SoundnessDeps` + the optional Q4 consistency table) are
 * repo-specific (ownership model, action-outcome wiring) and INJECTED on the
 * Capsule; this stage threads them straight through and adds no policy of its
 * own. `now` for the freshness window is taken from the injected deps so the
 * stage stays a pure pass-through to the pure kernel.
 */

import {
  runClaimsKernel,
  type CandidateClaim,
  type ClaimsKernelDeps,
  type ClaimsKernelResult,
  type EvidenceLedger,
} from "@adjudicate/core";
import type { Capsule } from "../capsule.js";
import type { CognitiveState, Plan } from "../ports/planner.js";

/**
 * Run the CLAIMS-VALIDATE stage. Returns the kernel result (renderable set +
 * terminal + per-claim verdicts + consistency record) when the claim pipeline is
 * wired (an investigator produced `ledger` AND a `claimPlanner` + `claimsKernel`
 * deps are present); otherwise `undefined`, leaving the legacy loop unchanged.
 *
 * Wiring requirement — the stage runs ONLY when all of:
 *  - `ledger` (from INVESTIGATE) is present;
 *  - `capsule.claimPlanner` is wired (the candidate source);
 *  - `capsule.claimsKernel` deps are present (the injected soundness/consistency
 *    capabilities the pure kernel composes).
 * A partial wiring (e.g. an investigator but no claim planner) runs no stage
 * rather than fabricating an empty validation — the pipeline is all-or-nothing
 * per turn, so a half-wired adopter can't accidentally "pass" claims unchecked.
 */
export async function runClaimsValidate(
  capsule: Capsule,
  cognition: CognitiveState,
  plan: Plan,
  ledger: EvidenceLedger | undefined,
): Promise<ClaimsKernelResult | undefined> {
  if (
    ledger === undefined ||
    capsule.claimPlanner === undefined ||
    capsule.claimsKernel === undefined
  ) {
    return undefined;
  }

  const candidates: ReadonlyArray<CandidateClaim> =
    await capsule.claimPlanner.propose({ cognition, plan });

  // EMPTY candidate set = nothing to assert (a greeting / smalltalk turn).
  // The pure kernel would map a non-suppressed RENDER terminal with an empty
  // renderable set to a terminal `UNKNOWN` (kernels.ts §I/§K) — but `UNKNOWN`
  // is honest ignorance about a REQUESTED claim, NOT "there was nothing to
  // claim" (SDD §I/§K). Returning no claims result here keeps the turn from
  // carrying a spurious claims-`UNKNOWN`; the stage is byte-equivalent to an
  // unwired pipeline for a turn with no candidate claims.
  if (candidates.length === 0) return undefined;

  const deps: ClaimsKernelDeps = capsule.claimsKernel;

  // P1 ∘ P2 over the threaded snapshot. PURE: same ledger + candidates + deps ⟹
  // same result. The kernel CONSUMES the ledger (read-only); this stage does not
  // mutate it (one-directional topology — SDD §F).
  return runClaimsKernel(ledger, candidates, deps);
}

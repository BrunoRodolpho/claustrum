/**
 * ClaimPlannerPort — the candidate-claim source for CLAIMS-VALIDATE (SDD §M /
 * §Q.6; v1.1 §8).
 *
 * The CLAIMS-VALIDATE stage is the deterministic post-planner WALL of the
 * Planner Sandbox (v1.1 §8): the (probabilistic) planner frames CANDIDATE claims
 * over the registry vocabulary; this port surfaces those candidates so the loop
 * can run them through the kernel's two deterministic gates — P1 soundness ∘ P2
 * consistency (`runClaimsKernel`, Q5) — against the threaded Evidence Ledger.
 *
 * Per SDD §Q.6 the claustrum half is the LOOP STAGE (this seam + the wiring in
 * `handleTurn`); the claim-aware planner that constrains generation over the
 * registry enum and the renderer-from-claims land DOWNSTREAM in ibatexas (§Q.6
 * planner port, §Q.7 renderer). claustrum only provides the seam + threads the
 * ledger; it never authors customer prose (Inv 6 / §O#3).
 *
 * The candidate it returns is the kernel's `CandidateClaim` (from
 * `@adjudicate/core`): a TYPED structure (soundness `MinimalClaim` +
 * subject/type/value), NEVER free-text reasoning — validation goes through the
 * §5 typed predicate, not prose (SDD §R topology condition 2).
 *
 * OPTIONAL on the Capsule (like {@link InvestigatorPort}): present only on a
 * conductor whose adopter wired the claim pipeline. Absent → no CLAIMS-VALIDATE
 * stage runs (the legacy loop is byte-equivalent).
 */

import type { CandidateClaim } from "@adjudicate/core";
import type { CognitiveState, Plan } from "./planner.js";

/**
 * What the claim planner sees. The resolved cognition + (post-RESOLVE) plan for
 * this turn — the same inputs the planner framed against — so the candidate
 * claims align with the proposed intents.
 */
export interface ClaimPlannerInput {
  readonly cognition: CognitiveState;
  readonly plan: Plan;
}

export interface ClaimPlannerPort {
  /**
   * Propose the CANDIDATE claims for this turn (SDD §M; v1.1 §8). NO validation
   * happens here — the candidates are the probabilistic planner's framing; the
   * deterministic walls (P1 soundness + P2 consistency) run in CLAIMS-VALIDATE.
   * Returns an empty array when the turn has no factual claim to make (the loop
   * then renders/observes as usual; an empty candidate set yields the kernel's
   * honest-ignorance terminal).
   */
  propose(input: ClaimPlannerInput): Promise<ReadonlyArray<CandidateClaim>>;
}

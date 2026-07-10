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

import type { CandidateClaim, EvidenceLedger } from "@adjudicate/core";
import type { CognitiveState, Plan } from "./planner.js";

/**
 * What the claim planner sees. The resolved cognition + (post-RESOLVE) plan for
 * this turn — the same inputs the planner framed against — so the candidate
 * claims align with the proposed intents.
 *
 * It ALSO carries the two AUTHENTICATED, owner-scoped inputs the loop holds (and
 * the model must NEVER author), so an owner-scoped candidate is framed from the
 * authenticated identity / owner-scoped reads rather than the model's
 * self-assertion (IDOR-safe — SDD §E C1; Inv 2):
 *   - `customerId` — the AUTHENTICATED principal for this turn (`capsule.customerId`),
 *     the SAME principal CLAIMS-VALIDATE's per-turn `owns` quantifies over. The
 *     claim planner stamps candidate actors from THIS, never a model/session
 *     self-reported actor.
 *   - `ledger`     — this turn's read-only Evidence Ledger AFTER INVESTIGATE, so the
 *     planner can resolve an owner-scoped claim SUBJECT from the owner-scoped reads
 *     that resolved PRESENT this turn (never a model/session-supplied resource id).
 * Both are OPTIONAL (additive): a planner that ignores them, or an adopter that
 * never wired them, is byte-identical to the prior `{ cognition, plan }` contract.
 */
export interface ClaimPlannerInput {
  readonly cognition: CognitiveState;
  readonly plan: Plan;
  /** The AUTHENTICATED principal for this turn (`capsule.customerId`). */
  readonly customerId?: string;
  /** This turn's read-only Evidence Ledger (post-INVESTIGATE). */
  readonly ledger?: EvidenceLedger;
}

/**
 * A turn terminal the claim planner may FORCE, carried out of `propose`
 * alongside its candidates (SDD §I; §O#9; §J.7/§J.8). Only the two SAFE,
 * planner-reachable terminals are expressible — the planner may raise the turn
 * to `ESCALATE` or `CLARIFY`, never DOWN to `RENDER` (rendering is earned by the
 * kernel's P1∘P2 validation, never asserted by the probabilistic planner):
 *
 *   - `ESCALATE` — a SAFETY route the deterministic P1∘P2 gates cannot see: an
 *                  unrecognized health/safety marker (allergen), a
 *                  harassment/medical-emergency span with no typed terminal
 *                  (SDD §O#9 — default-to-safe, closed taxonomy). It OUTRANKS
 *                  everything, including a would-be `RENDER` (SDD §J.7 fail
 *                  closed): a validated cheerful answer must NOT reach a customer
 *                  when a safety marker demands a human.
 *   - `CLARIFY`  — a genuine AMBIGUITY the planner detected but the kernel would
 *                  otherwise flatten to honest-ignorance `UNKNOWN`: e.g. a
 *                  customer with THREE payments asking "is my payment done?" —
 *                  the safe, useful turn is "which order?", not a generic
 *                  deflection (SDD §J.8 — an unmapped span forces CLARIFY, never
 *                  a silent drop). CLARIFY YIELDS to a complete `RENDER` (never
 *                  withhold a genuinely validated answer to ask a needless
 *                  question) and to a kernel `ESCALATE` (never downgrade a
 *                  safety/consistency escalation to a clarification).
 *
 * The precedence these two encode is applied at the single CLAIMS-VALIDATE seam
 * ({@link normalizeClaimPlannerResult} + the loop's `applyForcedTerminal`); it
 * never leaks a repo-specific policy into this port.
 */
export type ClaimPlannerForcedTerminal = "ESCALATE" | "CLARIFY";

/**
 * The RICHER `propose` return: the candidate set PLUS an optional planner-forced
 * turn terminal. This is the widened (non-legacy) branch of {@link
 * ClaimPlannerResult}. A planner that computes a forced terminal — a safety
 * ESCALATE or an ambiguity CLARIFY — returns this so the terminal is HONORED
 * downstream instead of being discarded (the pre-widening loss: a forced
 * ESCALATE silently became `UNKNOWN`, a forced CLARIFY a generic deflection).
 *
 * `forcedTerminal` omitted ⟺ behaviourally identical to returning `candidates`
 * as the bare legacy array.
 */
export interface ClaimPlannerProposal {
  readonly candidates: ReadonlyArray<CandidateClaim>;
  readonly forcedTerminal?: ClaimPlannerForcedTerminal;
}

/**
 * What {@link ClaimPlannerPort.propose} may return — a NON-BREAKING widening
 * (SDD §Q.6). Either shape is accepted:
 *
 *   - the LEGACY `ReadonlyArray<CandidateClaim>` — every existing adopter
 *     planner (and test double) returns exactly this and is byte-identical after
 *     the widening (the normalizer reads it as `{ candidates, forcedTerminal:
 *     undefined }`, so no terminal is ever forced); OR
 *   - the widened {@link ClaimPlannerProposal} `{ candidates, forcedTerminal? }`.
 *
 * The union is DISCRIMINATED by `Array.isArray` and NORMALIZED at the single
 * CLAIMS-VALIDATE call seam ({@link normalizeClaimPlannerResult}); nothing
 * downstream branches on the raw union.
 */
export type ClaimPlannerResult =
  | ReadonlyArray<CandidateClaim>
  | ClaimPlannerProposal;

export interface ClaimPlannerPort {
  /**
   * Propose the CANDIDATE claims for this turn (SDD §M; v1.1 §8), optionally with
   * a planner-FORCED turn terminal. NO validation happens here — the candidates
   * are the probabilistic planner's framing; the deterministic walls (P1
   * soundness + P2 consistency) run in CLAIMS-VALIDATE.
   *
   * Returns either:
   *   - the LEGACY bare `ReadonlyArray<CandidateClaim>` (an empty array when the
   *     turn has no factual claim to make — the loop renders/observes as usual;
   *     an empty candidate set yields the kernel's honest-ignorance terminal); or
   *   - a {@link ClaimPlannerProposal} `{ candidates, forcedTerminal? }` when the
   *     planner computed a safety `ESCALATE` / ambiguity `CLARIFY` that the
   *     deterministic gates cannot see. A forced terminal is HONORED even when
   *     `candidates` is EMPTY — a CLARIFY with no candidate (the 3-payments
   *     "which order?" case) still terminates the turn on CLARIFY rather than
   *     falling through to a generic deflection.
   *
   * The return type is a NON-BREAKING widening: an implementation returning the
   * bare array is unchanged and behaves identically (see {@link
   * ClaimPlannerResult}).
   */
  propose(input: ClaimPlannerInput): Promise<ClaimPlannerResult>;
}

/**
 * Normalize a {@link ClaimPlannerResult} (either branch of the widened union) to
 * the canonical `{ candidates, forcedTerminal? }` shape the CLAIMS-VALIDATE seam
 * consumes. PURE. The ONE place the legacy-array ↔ proposal-object union is
 * discriminated:
 *
 *   - a bare `ReadonlyArray<CandidateClaim>` → `{ candidates }` (no forced
 *     terminal → byte-identical to the pre-widening behaviour);
 *   - a `{ candidates, forcedTerminal? }` proposal → itself, normalized so
 *     `forcedTerminal` is present only when the planner set it.
 *
 * `Array.isArray` is the discriminant: a `ReadonlyArray` is an array; a
 * {@link ClaimPlannerProposal} is a plain object. Defensive on a malformed
 * proposal (missing `candidates`) — it degrades to an empty candidate set rather
 * than throwing, so a mis-shaped planner return can never crash the turn.
 */
export function normalizeClaimPlannerResult(result: ClaimPlannerResult): {
  readonly candidates: ReadonlyArray<CandidateClaim>;
  readonly forcedTerminal?: ClaimPlannerForcedTerminal;
} {
  if (Array.isArray(result)) {
    return { candidates: result };
  }
  const proposal = result as ClaimPlannerProposal;
  const candidates = Array.isArray(proposal.candidates)
    ? proposal.candidates
    : [];
  return proposal.forcedTerminal !== undefined
    ? { candidates, forcedTerminal: proposal.forcedTerminal }
    : { candidates };
}

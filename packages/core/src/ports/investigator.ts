/**
 * InvestigatorPort — the INVESTIGATE stage (SDD §M / §Q.6; v1.1 §7; Inv 7).
 *
 * The evidence-gathering half of the claims loop. INVESTIGATE turns this turn's
 * resolved reads + context into Evidence Ledger entries — the per-turn snapshot
 * the CLAIMS-VALIDATE stage validates candidate claims against. Per SDD §M the
 * Ledger is "built properly, not embedded in the responder": it is a STRUCTURAL
 * part of the cognitive loop, threaded from INVESTIGATE into CLAIMS-VALIDATE,
 * never reconstructed inside the responder.
 *
 * Topology (SDD §F, v1.1 §6 — asymmetric, one-directional): Read + Action FEED
 * the Evidence Ledger; the Claims Kernel sits DOWNSTREAM as the final output
 * authority. The Investigator is the runtime's Read/Action side of that feed —
 * it WRITES evidence INTO the ledger and returns nothing of its own; the kernel
 * (CLAIMS-VALIDATE) reads it OUT. The arrow never points backward.
 *
 * Inv 7 (error ≠ absence; fail CLOSED): a read that ERRORS must be recorded as a
 * distinct ledger state (`recordError`), NOT silently omitted — an omission is a
 * read ABSENCE and would let a missing safety read look like "nothing to say"
 * instead of "we could not check". The `EvidenceLedger` keeps those states
 * distinguishable (`error` vs `absent`); the investigator's job is to record
 * faithfully. The ledger is a pure data structure (no clock) — `fetchedAt`
 * timestamps are supplied BY this stage, so the investigator owns the clock, not
 * the ledger.
 *
 * OPTIONAL on the Capsule (like {@link ResolverPort} / `adjudicateOutput`): when
 * no investigator is wired, `handleTurn` runs no INVESTIGATE / CLAIMS-VALIDATE
 * stage and the loop is byte-equivalent to the legacy 7-stage path. The claim
 * pipeline is wired by the downstream adopter (ibatexas), never forced on every
 * turn.
 */

import type { EvidenceLedger } from "@adjudicate/core";
import type { CognitiveState, Plan } from "./planner.js";
import type { ChannelKind } from "./channel.js";

/**
 * What the INVESTIGATE stage sees. The resolved cognition + (post-RESOLVE) plan
 * for this turn, scoped to the principal so every evidence read stays
 * owner-scoped (money-safety; Inv 2/13 are enforced downstream by the Read
 * kernel, but the investigator must not load cross-principal entities).
 */
export interface InvestigateInput {
  readonly cognition: CognitiveState;
  /**
   * The plan AFTER the optional RESOLVE stage — the resolved envelopes whose
   * reads/action-outcomes the investigator gathers evidence for. Empty when the
   * planner proposed no mutation (a pure-INFORM turn still gathers read
   * evidence).
   */
  readonly plan: Plan;
  /** The principal id for this turn — scopes every evidence read (money-safety). */
  readonly customerId: string;
  readonly channel: ChannelKind;
  /**
   * The per-turn Evidence Ledger to WRITE into (SDD §M — threaded, not
   * responder-embedded). The investigator records entries (and errors) here; the
   * SAME instance is threaded onward to CLAIMS-VALIDATE. The investigator MUST
   * NOT read claims out of it — the topology is one-directional (SDD §F).
   */
  readonly ledger: EvidenceLedger;
}

export interface InvestigatorPort {
  /**
   * Gather this turn's evidence INTO `input.ledger` (SDD §M; v1.1 §7; Inv 7).
   *
   * Contract:
   *  - WRITE-ONLY into the ledger: `record` successful reads / action outcomes;
   *    `recordError` failed reads (error ≠ absence — Inv 7). NEVER `resolve`
   *    claims here (one-directional topology — SDD §F).
   *  - Returns `void`: the ledger is the output (threaded onward), not a return
   *    value — the snapshot is the single source of truth (no second copy).
   *  - Owner-scoped: load only `input.customerId`'s entities.
   *  - Pure-ish: the investigator may perform reads (IO), but the ledger it
   *    writes is a deterministic snapshot of those reads.
   */
  investigate(input: InvestigateInput): Promise<void>;
}

/**
 * INVESTIGATE — the evidence-gathering loop stage (SDD §M / §Q.6; v1.1 §7; Inv 7).
 *
 * Mints THE per-turn Evidence Ledger snapshot and hands it to the wired
 * `InvestigatorPort` to populate from this turn's resolved reads/context. The
 * returned ledger is the SAME instance threaded onward into CLAIMS-VALIDATE — the
 * snapshot is structural to the loop, never reconstructed in the responder
 * (SDD §M "built properly, not embedded in the responder").
 *
 * The ledger is constructed HERE (one per turn — never a cross-turn cache; v1.1
 * §7) keyed by the turn id, so the snapshot identity is the turn identity. Inv 7
 * (error ≠ absence) is a property of the ledger itself (`recordError` vs an
 * omission); this stage only OWNS the snapshot boundary and delegates faithful
 * recording to the investigator.
 */

import { EvidenceLedger } from "@adjudicate/core";
import type { Capsule } from "../capsule.js";
import type { CognitiveState, Plan } from "../ports/planner.js";

/**
 * Run the INVESTIGATE stage. Returns the populated per-turn ledger when an
 * investigator is wired, or `undefined` when none is — in which case the loop
 * runs no claim pipeline (byte-equivalent to the legacy path).
 *
 * The ledger is minted per turn (snapshot id = `turnId`) and the SAME instance
 * is returned for CLAIMS-VALIDATE to consume — threading is by identity, not by
 * copy, so a downstream consumer reads exactly what INVESTIGATE wrote.
 */
export async function runInvestigate(
  capsule: Capsule,
  cognition: CognitiveState,
  plan: Plan,
): Promise<EvidenceLedger | undefined> {
  if (capsule.investigator === undefined) return undefined;

  // ONE snapshot per turn (v1.1 §7 — never a cross-turn cache). Keyed by turnId
  // so the snapshot identity == the turn identity (deterministic, no RNG).
  const ledger = new EvidenceLedger(capsule.turnId);

  await capsule.investigator.investigate({
    cognition,
    plan,
    customerId: capsule.customerId,
    channel: capsule.channel,
    ledger,
  });

  return ledger;
}

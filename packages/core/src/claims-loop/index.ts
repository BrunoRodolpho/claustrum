/**
 * @claustrum/core/claims-loop — the INVESTIGATE + CLAIMS-VALIDATE stages
 * (SDD §M / §Q.6; v1.1 §4, §7, §8).
 *
 * The two new bracketed cognitive-loop stages that thread the per-turn Evidence
 * Ledger:
 *   - INVESTIGATE     (`runInvestigate`)     — gathers evidence INTO the ledger.
 *   - CLAIMS-VALIDATE (`runClaimsValidate`)  — runs the published Claims Kernel
 *                                              (P1 ∘ P2) over the threaded ledger
 *                                              → renderable set + turn terminal.
 *
 * Both consume the published `@adjudicate/core` claims runtime (Q1–Q5); the
 * dependency arrow never points backward (SDD §F / §R: adjudicate → claustrum).
 */

export { runInvestigate } from "./investigate.js";
export { runClaimsValidate } from "./claims-validate.js";

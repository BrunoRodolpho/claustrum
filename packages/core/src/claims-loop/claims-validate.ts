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
 * Capsule; this stage adds NO policy of its own. Between the planner and the
 * kernel it runs a PER-TURN RECONCILIATION over the threaded read-only ledger
 * that only adjusts kernel INPUTS (never a verdict, never a skipped conjunct):
 * (1) it FLOORS `now` up to the newest same-turn first-party read (live OR
 * cacheable) so a read taken this turn is not future-stale; (2) when wired, it rebuilds the per-turn
 * `owns` / `outcomeConfirmed` from this turn's owner-scoped ledger reads + the
 * authenticated `customerId` (`claimsKernelDepsForTurn`); and (4b) it binds a
 * still-undefined bound candidate's `value` to its PRESENT first-party ledger
 * entry so C6 compares ledger-sourced scalars. The pure kernel then runs the full
 * §5 predicate over the reconciled inputs.
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

  // CLAIM-PLANNER CALL — the ONE probabilistic step in this otherwise-deterministic
  // stage: the claim planner is model-backed, so `propose` can THROW on a model /
  // tool-call failure (e.g. an Ollama tool-call XML parse error: `element
  // <parameter>…`). A planner failure is NOT evidence of anything — it must DEGRADE
  // SAFE, never escape the turn. Catch it, log it, and return `undefined`: no
  // candidate claims → no claims result → the turn falls through to the existing
  // responder / safe path (handle-turn step 6, byte-equivalent to an unwired
  // pipeline), exactly as for an empty candidate set below. We do NOT fabricate a
  // claim, do NOT emit a partial/garbage candidate from a failed parse, and do NOT
  // map the failure to a spurious claims-`UNKNOWN` terminal — a planner that could
  // not produce candidates asserted nothing, so the turn asserts nothing.
  let candidates: ReadonlyArray<CandidateClaim>;
  try {
    // Thread the AUTHENTICATED principal + this turn's read-only ledger to the
    // claim planner so an owner-scoped candidate's actor + subject derive from the
    // authenticated identity / owner-scoped reads, NEVER the model's self-assertion
    // (IDOR-safe — SDD §E C1, Inv 2). INVESTIGATE (step 4b) already populated the
    // ledger, so the planner sees the owner-scoped reads that resolved PRESENT.
    candidates = await capsule.claimPlanner.propose({
      cognition,
      plan,
      customerId: capsule.customerId,
      ledger,
    });
  } catch (error) {
    // DEGRADE SAFE — the planner could not produce candidates this turn. Surface
    // a single diagnostic (no logger/telemetry channel exists for a degraded
    // sub-stage; the output-firewall catch is likewise silent) and return
    // `undefined`. Returning here — rather than rethrowing or fabricating — keeps
    // the turn alive on the legacy responder/safe path.
    console.warn(
      "[claims-validate] claim-planner propose failed; degrading to no-claims (safe fall-through):",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }

  // EMPTY candidate set = nothing to assert (a greeting / smalltalk turn).
  // The pure kernel would map a non-suppressed RENDER terminal with an empty
  // renderable set to a terminal `UNKNOWN` (kernels.ts §I/§K) — but `UNKNOWN`
  // is honest ignorance about a REQUESTED claim, NOT "there was nothing to
  // claim" (SDD §I/§K). Returning no claims result here keeps the turn from
  // carrying a spurious claims-`UNKNOWN`; the stage is byte-equivalent to an
  // unwired pipeline for a turn with no candidate claims.
  if (candidates.length === 0) return undefined;

  // ── PER-TURN RECONCILIATION (post-INVESTIGATE / pre-kernel) ──────────────────
  // The single coherent point where THIS turn's live evidence is reconciled into
  // the kernel INPUTS. It sets NO verdict and skips NO conjunct: `runClaimsKernel`
  // below still runs the full §5 predicate (C0/∀-evidence/freshness/provenance/
  // ownership/C4/C6 + the falsifier CAP + the CE#3 runtime arm) over the result.

  // (1) FRESHNESS FLOOR — clock-ordering fix (loop-side; the kernel guard is
  //     CORRECT and stays). The Conductor captures the per-turn `now` at
  //     openCapsule (turn START), BEFORE the investigator stamps each read's
  //     `fetchedAt = Date.now()`. A SAME-TURN first-party read can thus carry
  //     `fetchedAt > now` by a few ms → the kernel's correct negative-age guard
  //     (`age >= 0`) rejects it → a valid this-turn read demotes to UNKNOWN.
  //     FLOOR `now` up to the newest SAME-TURN first-party read's `fetchedAt`
  //     so a read taken THIS turn is never future-stale.
  //
  //     GENERALIZATION (was: `sourceMode === "live"` only). A first-party read
  //     can legitimately carry a CACHEABLE freshness policy (`sourceMode` ==
  //     "cache" with a TTL) yet still be READ THIS TURN — e.g. STORE_OPEN_NOW's
  //     schedule evidence (freshnessPolicy {cacheable, ttl:3600}). Its
  //     investigator stamp is `fetchedAt ≈ now + ε`, so the live-only floor left
  //     `now` unraised → the kernel's cacheable freshness check (`age = now -
  //     fetchedAt; age >= 0 && age <= ttl`) saw `age < 0` → UNKNOWN. So floor
  //     over ALL PRESENT first-party entries whose `fetchedAt` is AFTER the
  //     frozen turn-start `now` (= reads taken THIS turn), regardless of
  //     live-vs-cacheable `sourceMode`.
  //
  //     STALE-CACHE SAFETY (load-bearing): the predicate is `fetchedAt >
  //     frozenNow`. A genuinely-stale CACHED entry has `fetchedAt ≪ now`
  //     (`fetchedAt < frozenNow`) → it is EXCLUDED → it cannot raise the floor →
  //     its age stays large → it stays correctly stale / demotes to UNKNOWN. The
  //     floor only ever RAISES `now` to absorb the few-ms clock skew of
  //     same-turn reads; it never reaches backwards to rescue an old cache.
  //     `must_read_this_turn` freshness is clock-independent and unaffected, and
  //     the kernel negative-age guard is NOT relaxed (it stays in adjudicate).
  let deps: ClaimsKernelDeps = capsule.claimsKernel;
  const frozenNow = deps.soundness.now;
  let maxSameTurnFetchedAt = Number.NEGATIVE_INFINITY;
  for (const key of ledger.keys()) {
    const resolution = ledger.resolve(key);
    if (
      resolution.state === "present" &&
      resolution.entry !== undefined &&
      resolution.entry.originProvenance === "FIRST_PARTY" &&
      resolution.entry.fetchedAt > frozenNow &&
      resolution.entry.fetchedAt > maxSameTurnFetchedAt
    ) {
      maxSameTurnFetchedAt = resolution.entry.fetchedAt;
    }
  }
  const flooredNow = Math.max(frozenNow, maxSameTurnFetchedAt);
  if (flooredNow !== frozenNow) {
    deps = { ...deps, soundness: { ...deps.soundness, now: flooredNow } };
  }

  // (2) PER-TURN OWNS — the W5b conductor seam. The process-wide `claimsKernel`
  //     deps carry a boot-empty owner set (`owns → false`), so an owner-scoped
  //     ORDER/PAYMENT claim could never VALIDATE even for its legit owner. When
  //     the adopter wired the per-turn builder, invoke it HERE with this turn's
  //     read-only ledger + the AUTHENTICATED `customerId` so it can rebuild `owns`
  //     from the owner-scoped reads that actually returned PRESENT this turn.
  //     IDOR stays closed: the builder derives the owned set ONLY from
  //     owner-scoped present reads + the authenticated principal — never a
  //     session/model-supplied id ("no owner" ≠ "any owner"). Absent → the static
  //     `base` (byte-identical). `base` already carries the floored `now`.
  if (capsule.claimsKernelDepsForTurn !== undefined) {
    deps = capsule.claimsKernelDepsForTurn({
      ledger,
      customerId: capsule.customerId,
      base: deps,
    });
  }

  // (4b) LEDGER-EXACT VALUE DERIVATION. A bound candidate whose `value` is still
  //      undefined (the owner-scoped per-resource types the planner cannot re-read
  //      without re-opening an IDOR) gets its value from the PRESENT first-party
  //      ledger entry the investigator recorded this turn. This keeps the model a
  //      value-AUTHOR no longer (it emits the type TAG only) and lets C6 compare a
  //      real scalar on BOTH sides — claim value == evidence value, each projected
  //      by the SAME `valueBinding.path` — PASSing BY CONSTRUCTION without skipping
  //      any conjunct. The FULL entry value is bound (not a pre-projected scalar)
  //      so C6's path projection lines up. A cross-owner / absent read is NOT
  //      present → value stays undefined → C6 ABSTAINs (or the ∀-evidence demotes)
  //      → honest UNKNOWN. A claim that already carries a value, or declares no
  //      `valueBinding`, is untouched.
  const reconciledCandidates: ReadonlyArray<CandidateClaim> = candidates.map(
    (candidate) => {
      const binding = candidate.soundness.valueBinding;
      if (binding === undefined || candidate.value !== undefined) {
        return candidate;
      }
      const resolution = ledger.resolve(binding.key);
      if (resolution.state !== "present" || resolution.entry === undefined) {
        return candidate;
      }
      return { ...candidate, value: resolution.entry.value };
    },
  );

  // P1 ∘ P2 over the threaded snapshot. PURE: same ledger + candidates + deps ⟹
  // same result. The kernel CONSUMES the ledger (read-only); this stage does not
  // mutate it (one-directional topology — SDD §F).
  return runClaimsKernel(ledger, reconciledCandidates, deps);
}

/**
 * BKL-077 — ClaimPlannerPort carries a FORCED turn terminal (ESCALATE/CLARIFY).
 *
 * The claim planner may compute a terminal the deterministic P1∘P2 gates cannot
 * see — a SAFETY `ESCALATE` (allergen / unrecognized health marker, SDD §O#9)
 * or an AMBIGUITY `CLARIFY` (a customer with 3 payments asking "is my payment
 * done?" → "which order?", SDD §J.8). Before this change `propose` returned only
 * `CandidateClaim[]`, so the forced terminal was DISCARDED: the ESCALATE became
 * `UNKNOWN`, and the CLARIFY (no bindable candidate) fell through to the legacy
 * responder as a generic deflection. Both were live-proven in ibatexas.
 *
 * These tests pin, using ONLY the real published `@adjudicate/core` claims
 * runtime + in-memory doubles (no model / DB / network):
 *   1. `resolveTurnTerminal` — the pure precedence lattice (exhaustive).
 *   2. `normalizeClaimPlannerResult` — the legacy-array ↔ proposal-object union.
 *   3. `runClaimsValidate` end-to-end — a legacy-array planner is byte-identical;
 *      a forced ESCALATE outranks a would-be RENDER; a forced CLARIFY with NO
 *      candidate still terminates the turn (the regression); a forced CLARIFY
 *      YIELDS to a complete RENDER and OVERRIDES an honest-ignorance UNKNOWN.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
  type ClaimsKernelDeps,
  type EvidenceEntryInput,
  type TurnTerminal,
} from "@adjudicate/core";
import {
  normalizeClaimPlannerResult,
  resolveTurnTerminal,
  runClaimsValidate,
  type Capsule,
  type ClaimPlannerForcedTerminal,
  type ClaimPlannerPort,
  type ClaimPlannerResult,
  type CognitiveState,
  type Plan,
} from "../src/index.js";

const FIXED_NOW = "2026-06-25T12:00:00.000Z";
const NOW_MS = Date.parse(FIXED_NOW);
const CUSTOMER = "cust-forced";
const ORDER = "order-1";

// ── Fixtures (mirrors claims-loop.test.ts) ───────────────────────────────────

/** A present + live + TRUSTED evidence entry → its sound candidate VALIDATEs. */
function stageEntry(key: string): EvidenceEntryInput {
  return {
    key,
    value: "out_for_delivery",
    source: "OrderProjection",
    fetchedAt: NOW_MS,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  };
}

/** A candidate whose ONLY required evidence `key` is present in the ledger → VALIDATED. */
function soundCandidate(key: string, type: string): CandidateClaim {
  return {
    soundness: {
      requiredEvidence: [
        {
          key,
          ownershipPolicy: "required",
          freshnessPolicy: "must_read_this_turn",
          sourceIntegrity: "trusted_service",
          provenancePolicy: "preserve",
        },
      ],
      minSourceIntegrity: "trusted_service",
      kind: "read_claim",
      actor: { customerId: CUSTOMER },
      resources: { [key]: ORDER },
      falsifierComplete: true,
      falsifiers: [
        {
          key: `${key}:falsifier`,
          ownershipPolicy: "required",
          freshnessPolicy: "must_read_this_turn",
          sourceIntegrity: "trusted_service",
          provenancePolicy: "preserve",
        },
      ],
    },
    subject: ORDER,
    type,
    value: "out_for_delivery",
  };
}

/** A candidate whose required evidence is ABSENT → UNKNOWN (honest ignorance). */
function unsoundCandidate(key: string, type: string): CandidateClaim {
  return {
    soundness: {
      requiredEvidence: [
        {
          key, // never recorded → absent
          ownershipPolicy: "not_applicable",
          freshnessPolicy: "static",
          sourceIntegrity: "structured",
          provenancePolicy: "preserve",
        },
      ],
      minSourceIntegrity: "structured",
      kind: "read_claim",
      actor: { customerId: CUSTOMER },
    },
    subject: ORDER,
    type,
    value: "guessed",
  };
}

const claimsKernel: ClaimsKernelDeps = {
  soundness: {
    owns: () => true,
    outcomeConfirmed: () => true,
    now: NOW_MS,
  },
};

/** A claim planner returning a FIXED widened result (array or proposal). */
function fixedPlanner(result: ClaimPlannerResult): ClaimPlannerPort {
  return { async propose() { return result; } };
}

/** Minimal Capsule carrying only what `runClaimsValidate` reads. */
function makeCapsule(claimPlanner: ClaimPlannerPort): Capsule {
  return {
    customerId: CUSTOMER,
    claimPlanner,
    claimsKernel,
  } as unknown as Capsule;
}

const COGNITION = {
  perception: { text: "is my payment done?" },
} as unknown as CognitiveState;
const PLAN: Plan = { envelopes: [] };

/** Populate a fresh per-turn ledger with the given entries. */
function ledgerWith(entries: ReadonlyArray<EvidenceEntryInput>): EvidenceLedger {
  const ledger = new EvidenceLedger("turn-forced");
  for (const e of entries) ledger.record(e);
  return ledger;
}

async function validate(
  planner: ClaimPlannerPort,
  entries: ReadonlyArray<EvidenceEntryInput> = [stageEntry(`stage:${ORDER}`)],
) {
  return runClaimsValidate(
    makeCapsule(planner),
    COGNITION,
    PLAN,
    ledgerWith(entries),
  );
}

// ── 1. resolveTurnTerminal — the pure precedence lattice ─────────────────────

describe("resolveTurnTerminal — precedence (BKL-077; SDD §I/§O#9/§J.7/§J.8)", () => {
  const kernelTerminals: TurnTerminal[] = [
    "RENDER",
    "UNKNOWN",
    "ESCALATE",
    "CLARIFY",
  ];

  it("no forced terminal → the kernel terminal is passed through unchanged", () => {
    for (const t of kernelTerminals) {
      expect(resolveTurnTerminal(t, undefined)).toBe(t);
    }
  });

  it("forced ESCALATE OUTRANKS EVERYTHING, including a would-be RENDER (safety)", () => {
    for (const t of kernelTerminals) {
      expect(resolveTurnTerminal(t, "ESCALATE")).toBe("ESCALATE");
    }
  });

  it("forced CLARIFY YIELDS to a complete RENDER and to a kernel ESCALATE", () => {
    // Never withhold a validated answer to ask a needless question…
    expect(resolveTurnTerminal("RENDER", "CLARIFY")).toBe("RENDER");
    // …and never downgrade a safety/consistency escalation to a clarification.
    expect(resolveTurnTerminal("ESCALATE", "CLARIFY")).toBe("ESCALATE");
  });

  it("forced CLARIFY OVERRIDES an honest-ignorance UNKNOWN (and a kernel CLARIFY)", () => {
    expect(resolveTurnTerminal("UNKNOWN", "CLARIFY")).toBe("CLARIFY");
    expect(resolveTurnTerminal("CLARIFY", "CLARIFY")).toBe("CLARIFY");
  });

  it("a forced terminal can NEVER manufacture a RENDER (planner cannot earn a render)", () => {
    const forced: ClaimPlannerForcedTerminal[] = ["ESCALATE", "CLARIFY"];
    for (const f of forced) {
      for (const t of kernelTerminals) {
        const out = resolveTurnTerminal(t, f);
        if (t !== "RENDER") expect(out).not.toBe("RENDER");
      }
    }
  });
});

// ── 2. normalizeClaimPlannerResult — the union discriminant ──────────────────

describe("normalizeClaimPlannerResult — legacy-array ↔ proposal union", () => {
  const cands = [soundCandidate("k", "T")];

  it("a bare array normalizes to { candidates, forcedTerminal: undefined }", () => {
    const n = normalizeClaimPlannerResult(cands);
    expect(n.candidates).toBe(cands);
    expect(n.forcedTerminal).toBeUndefined();
  });

  it("a proposal WITHOUT forcedTerminal carries no forced terminal", () => {
    const n = normalizeClaimPlannerResult({ candidates: cands });
    expect(n.candidates).toEqual(cands);
    expect(n.forcedTerminal).toBeUndefined();
  });

  it("a proposal WITH forcedTerminal preserves it", () => {
    const n = normalizeClaimPlannerResult({ candidates: cands, forcedTerminal: "CLARIFY" });
    expect(n.candidates).toEqual(cands);
    expect(n.forcedTerminal).toBe("CLARIFY");
  });

  it("a malformed proposal (missing candidates) degrades to an empty set, never throws", () => {
    const n = normalizeClaimPlannerResult({ forcedTerminal: "ESCALATE" } as ClaimPlannerResult);
    expect(n.candidates).toEqual([]);
    expect(n.forcedTerminal).toBe("ESCALATE");
  });
});

// ── 3. runClaimsValidate end-to-end ──────────────────────────────────────────

describe("runClaimsValidate — honors a forced terminal (BKL-077)", () => {
  it("the empty kernel result is UNKNOWN (the assumption the no-candidate path relies on)", () => {
    // applyForcedTerminal over an empty run only reaches CLARIFY because the
    // empty kernel terminal is a non-RENDER UNKNOWN (not RENDER, which CLARIFY
    // would yield to). Pin the kernel behaviour this change depends on.
    const empty = runClaimsKernel(new EvidenceLedger("t"), [], claimsKernel);
    expect(empty.terminal).toBe("UNKNOWN");
    expect(empty.renderable).toHaveLength(0);
    expect(empty.renderableCanonical).toHaveLength(0);
  });

  it("COMPAT: a legacy-array planner is byte-identical to the pre-widening result", async () => {
    const key = `stage:${ORDER}`;
    const legacy = await validate(fixedPlanner([soundCandidate(key, "ORDER_FULFILLMENT_STAGE")]));
    const proposalNoForce = await validate(
      fixedPlanner({ candidates: [soundCandidate(key, "ORDER_FULFILLMENT_STAGE")] }),
    );
    expect(legacy).toBeDefined();
    expect(legacy!.terminal).toBe("RENDER");
    expect(legacy!.renderable.map((c) => c.type)).toEqual(["ORDER_FULFILLMENT_STAGE"]);
    // The bare array and a forcedTerminal-less proposal produce the SAME result.
    expect(proposalNoForce).toEqual(legacy);
  });

  it("an empty-array planner with no forced terminal returns undefined (greeting; legacy)", async () => {
    const result = await validate(fixedPlanner([]));
    expect(result).toBeUndefined();
  });

  it("forced ESCALATE OUTRANKS a would-be RENDER; renderable is suppressed, verdicts preserved", async () => {
    const key = `stage:${ORDER}`;
    const result = await validate(
      fixedPlanner({
        candidates: [soundCandidate(key, "ORDER_FULFILLMENT_STAGE")],
        forcedTerminal: "ESCALATE",
      }),
    );
    expect(result).toBeDefined();
    // Terminal is forced up to ESCALATE even though the claim VALIDATED…
    expect(result!.terminal).toBe("ESCALATE");
    // …and NOTHING renders (a safety route must not leak the answer it overrode).
    expect(result!.renderable).toHaveLength(0);
    expect(result!.renderableCanonical).toHaveLength(0);
    // …but the per-claim audit is PRESERVED (P4 completeness — no silent drop).
    expect(result!.perClaim).toEqual([
      { subject: ORDER, type: "ORDER_FULFILLMENT_STAGE", verdict: "VALIDATED" },
    ]);
  });

  it("THE REGRESSION: forced CLARIFY with NO candidate still terminates on CLARIFY (3-payments)", async () => {
    // The customer has 3 payments; the planner frames a CLARIFY but no bindable
    // candidate. Pre-widening this returned undefined → generic deflection.
    const result = await validate(
      fixedPlanner({ candidates: [], forcedTerminal: "CLARIFY" }),
    );
    expect(result).toBeDefined(); // ← no longer discarded
    expect(result!.terminal).toBe("CLARIFY");
    expect(result!.renderable).toHaveLength(0);
    expect(result!.renderableCanonical).toHaveLength(0);
  });

  it("forced ESCALATE with NO candidate terminates on ESCALATE (unrecognized safety marker)", async () => {
    const result = await validate(
      fixedPlanner({ candidates: [], forcedTerminal: "ESCALATE" }),
    );
    expect(result).toBeDefined();
    expect(result!.terminal).toBe("ESCALATE");
    expect(result!.renderable).toHaveLength(0);
  });

  it("forced CLARIFY YIELDS to a complete RENDER (validated answer is not withheld)", async () => {
    const key = `stage:${ORDER}`;
    const result = await validate(
      fixedPlanner({
        candidates: [soundCandidate(key, "ORDER_FULFILLMENT_STAGE")],
        forcedTerminal: "CLARIFY",
      }),
    );
    expect(result).toBeDefined();
    expect(result!.terminal).toBe("RENDER");
    expect(result!.renderable.map((c) => c.type)).toEqual(["ORDER_FULFILLMENT_STAGE"]);
    expect(result!.renderableCanonical.length).toBeGreaterThan(0);
  });

  it("forced CLARIFY OVERRIDES an honest-ignorance UNKNOWN", async () => {
    // The single candidate's evidence is absent → the kernel terminal is UNKNOWN;
    // the planner's CLARIFY is the more useful, honest turn.
    const result = await validate(
      fixedPlanner({
        candidates: [unsoundCandidate("never-recorded", "ORDER_DELAY_REASON")],
        forcedTerminal: "CLARIFY",
      }),
    );
    expect(result).toBeDefined();
    expect(result!.terminal).toBe("CLARIFY");
    expect(result!.renderable).toHaveLength(0);
    // The unsound candidate still got its explicit UNKNOWN verdict (completeness).
    expect(result!.perClaim).toEqual([
      { subject: ORDER, type: "ORDER_DELAY_REASON", verdict: "UNKNOWN" },
    ]);
  });
});

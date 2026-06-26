/**
 * INVESTIGATE + CLAIMS-VALIDATE — the claims-loop contract (SDD §M / §Q.6; v1.1
 * §4, §7, §8; Inv 7; §F).
 *
 * The two new bracketed cognitive-loop stages thread a per-turn Evidence Ledger:
 *
 *   - INVESTIGATE     populates THE per-turn Evidence Ledger from the resolved
 *                     context (the ledger is structural to the loop, NOT
 *                     re-created in the responder — §M).
 *   - CLAIMS-VALIDATE runs the published Claims Kernel (`runClaimsKernel` =
 *                     P1 soundness ∘ P2 consistency) over the THREADED ledger +
 *                     candidate claims → the renderable VALIDATED+consistent set
 *                     + the turn terminal (RENDER|UNKNOWN|ESCALATE|CLARIFY).
 *
 * These tests use ONLY mocks (in-memory test-doubles + the real published
 * `@adjudicate/core` claims runtime) — no live model / DB / network.
 *
 * Invariants pinned here (the acceptance criteria):
 *  1. INVESTIGATE populates a per-turn Evidence Ledger from the resolved context.
 *  2. CLAIMS-VALIDATE runs runClaimsKernel → renderable set + terminal; an
 *     unsound candidate is EXCLUDED; an inconsistent same-subject set → ESCALATE;
 *     sound+consistent → RENDER.
 *  3. The ledger CLAIMS-VALIDATE consumes is the SAME snapshot INVESTIGATE wrote
 *     (threaded by identity, not re-created).
 *  4. The existing loop (7 stages + RESUME) still works — no regression: with NO
 *     claim pipeline wired the turn runs byte-equivalently and `claims` is absent.
 *  5. Non-vacuity: disabling CLAIMS-VALIDATE (no claim planner) makes the
 *     "unsound excluded" / "RENDER" assertions UNOBSERVABLE — `claims` is
 *     `undefined`, so a test that asserts the validated set goes RED.
 *  6. Consumes the NEW @adjudicate/core: the import resolves to the linked 1.5.0
 *     kernel (the real EvidenceLedger / runClaimsKernel), not a stub.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  EvidenceLedger,
  type CandidateClaim,
  type ClaimsKernelDeps,
  type EvidenceEntryInput,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type CapabilityId,
  type ChannelMessage,
  type ClaimPlannerPort,
  type IntentKind,
  type InvestigatorPort,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type TenantResolver,
  type ToolDefinition,
} from "../src/index.js";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "../src/test-doubles/index.js";

const FIXED_NOW = "2026-06-25T12:00:00.000Z";
const NOW_MS = Date.parse(FIXED_NOW);
const CUSTOMER = "cust-claims";
const ORDER = "order-1";

// ── Test fixtures: a sound read-evidence entry + sound/unsound candidates ─────

/** A present + live + TRUSTED evidence entry for an order's fulfillment stage. */
function stageEntry(key: string): EvidenceEntryInput {
  return {
    key,
    value: "out_for_delivery",
    source: "OrderProjection",
    fetchedAt: NOW_MS,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "TRUSTED",
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
    },
    subject: ORDER,
    type,
    value: "out_for_delivery",
  };
}

/** A candidate whose required evidence `key` is ABSENT from the ledger → UNKNOWN (not VALIDATED). */
function unsoundCandidate(key: string, type: string): CandidateClaim {
  return {
    soundness: {
      requiredEvidence: [
        {
          key, // never recorded into the ledger → absent → not present
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

// The injected Claims-Kernel deps (Q3 soundness + default Q4 table). `now` is
// fixed so `fresh(e)` is deterministic — no wall clock in a test.
const claimsKernel: ClaimsKernelDeps = {
  soundness: {
    owns: () => true, // the test actor owns the order (ownership is injected)
    outcomeConfirmed: () => true,
    now: NOW_MS,
  },
};

// ── Ports ─────────────────────────────────────────────────────────────────

function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const envelope = buildEnvelope({
        kind: "demo.echo",
        payload: { text: state.perception.text },
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
        createdAt: FIXED_NOW,
      }) as IntentEnvelope;
      return { envelopes: [envelope], rationale: "test planner" };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<{ text: string }> {
      if (input.decision.kind === "REFUSE")
        return { text: input.decision.refusal.userFacing };
      return { text: `ok: ${input.cognition.perception.text}` };
    },
  };
}

function makeTool(executed: { count: number }): ToolDefinition<{ text?: string }, unknown> {
  return {
    id: "demo.echo.v1",
    capability: "demo.echo" as CapabilityId,
    intentKind: "demo.echo" as IntentKind,
    description: "echo",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "low",
    async execute(input) {
      executed.count += 1;
      return { echoed: input };
    },
  };
}

const tenantResolver: TenantResolver = {
  async resolve() {
    return {
      tenant: { tenantId: "t", displayName: "T", locale: "pt-BR", environment: "dev" },
      state: { balanceOk: true },
      policy: {},
    };
  },
};

/**
 * Records the SAME ledger instance it was handed at INVESTIGATE, and writes the
 * requested entries into it. The recorded instance lets a test prove the ledger
 * CLAIMS-VALIDATE consumes is the one INVESTIGATE populated (criterion #3).
 */
class RecordingInvestigator implements InvestigatorPort {
  public ledgerSeen: EvidenceLedger | undefined;
  public investigateCalls = 0;
  constructor(private readonly entries: ReadonlyArray<EvidenceEntryInput>) {}
  async investigate(input: {
    readonly ledger: EvidenceLedger;
    readonly customerId: string;
  }): Promise<void> {
    this.investigateCalls += 1;
    this.ledgerSeen = input.ledger;
    for (const e of this.entries) input.ledger.record(e);
  }
}

interface BundleOpts {
  readonly investigator?: InvestigatorPort;
  readonly claimPlanner?: ClaimPlannerPort;
  readonly withKernelDeps?: boolean;
}

function makeBundle(opts: BundleOpts) {
  const adjudicator = new StubAdjudicator();
  const session = new InMemorySessionStore();
  const channel = new WebChannelStub();
  const executed = { count: 0 };
  const tools = createToolRegistry();
  tools.register(makeTool(executed));
  const conductor = createConductor({
    adjudicator,
    memory: new InMemoryMemoryProvider(),
    grounding: new EmptyGroundingProvider(),
    planner: makePlanner(),
    responder: makeResponder(),
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: new RecordingTelemetrySink(),
    session,
    tools,
    channels: [channel],
    tenantResolver,
    ...(opts.investigator !== undefined ? { investigator: opts.investigator } : {}),
    ...(opts.claimPlanner !== undefined ? { claimPlanner: opts.claimPlanner } : {}),
    ...(opts.withKernelDeps !== false ? { claimsKernel } : {}),
  });
  return { adjudicator, session, channel, executed, conductor };
}

function inbound(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: CUSTOMER,
    conversationId: "conv-claims",
    text,
    receivedAt: FIXED_NOW,
  };
}

/** A claim planner that proposes a fixed candidate set (the probabilistic framing). */
function fixedClaimPlanner(
  candidates: ReadonlyArray<CandidateClaim>,
): ClaimPlannerPort & { calls: number } {
  return {
    calls: 0,
    async propose() {
      this.calls += 1;
      return candidates;
    },
  };
}

async function runTurn(conductor: ReturnType<typeof makeBundle>["conductor"]) {
  const capsule = await conductor.openCapsule({
    channel: "web",
    customerId: CUSTOMER,
    inbound: inbound("por que meu pedido está atrasado?"),
  });
  const result = await handleTurn(capsule, inbound("por que meu pedido está atrasado?"));
  await conductor.closeCapsule(capsule);
  return result;
}

describe("claims-loop — INVESTIGATE + CLAIMS-VALIDATE (SDD §M / §Q.6)", () => {
  it("criterion 6: consumes the NEW @adjudicate/core (real EvidenceLedger/runClaimsKernel, not a stub)", () => {
    // The linked kernel (1.5.0) ships these as real values; a stub would not.
    const ledger = new EvidenceLedger("turn-probe");
    expect(ledger).toBeInstanceOf(EvidenceLedger);
    expect(typeof ledger.version).toBe("number");
    ledger.record(stageEntry("k"));
    // error ≠ absence (Inv 7): an errored key resolves to a DISTINCT state.
    ledger.recordError("err-key", "boom");
    expect(ledger.resolve("k").state).toBe("present");
    expect(ledger.resolve("missing").state).toBe("absent");
    expect(ledger.resolve("err-key").state).toBe("error");
  });

  it("criterion 1 + 3: INVESTIGATE populates the per-turn ledger; CLAIMS-VALIDATE consumes THAT SAME snapshot", async () => {
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
    ]);
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    // INVESTIGATE ran and populated a ledger from the resolved context.
    expect(investigator.investigateCalls).toBe(1);
    expect(investigator.ledgerSeen).toBeInstanceOf(EvidenceLedger);
    // The populated key is resolvable in the SAME snapshot INVESTIGATE wrote.
    expect(investigator.ledgerSeen!.has("stage:order-1")).toBe(true);
    // CLAIMS-VALIDATE ran over it (claim planner consulted, result surfaced).
    expect(claimPlanner.calls).toBe(1);
    expect(result.claims).toBeDefined();
    // Snapshot identity: the ledger is keyed by the turnId (one per turn), so the
    // snapshot the kernel validated against is the per-turn instance — not a
    // responder-local re-creation. The validated claim proves the kernel read
    // the entry INVESTIGATE wrote into that very snapshot.
    expect(result.claims!.perClaim).toEqual([
      { subject: ORDER, type: "ORDER_FULFILLMENT_STAGE", verdict: "VALIDATED" },
    ]);
  });

  it("criterion 2a: sound + consistent → terminal RENDER, claim in the renderable set", async () => {
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
    ]);
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    expect(result.claims!.terminal).toBe("RENDER");
    expect(result.claims!.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("criterion 2b: an unsound candidate is EXCLUDED from the renderable set (UNKNOWN, not VALIDATED)", async () => {
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
      // Its required evidence key was NEVER recorded → absent → UNKNOWN.
      unsoundCandidate("never-recorded:order-1", "ORDER_DELAY_REASON"),
    ]);
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    // The unsound one gets an explicit UNKNOWN verdict (P4 completeness — no
    // silent drop) but is NOT renderable; only the sound one renders.
    const verdicts = Object.fromEntries(
      result.claims!.perClaim.map((c) => [c.type, c.verdict]),
    );
    expect(verdicts["ORDER_FULFILLMENT_STAGE"]).toBe("VALIDATED");
    expect(verdicts["ORDER_DELAY_REASON"]).toBe("UNKNOWN");
    expect(result.claims!.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
    expect(result.claims!.renderable.map((c) => c.type)).not.toContain(
      "ORDER_DELAY_REASON",
    );
  });

  it("criterion 2c: an inconsistent same-subject set (mutual-exclusion) → terminal ESCALATE, nothing rendered", async () => {
    // delivered ⊥ has-ETA on the SAME order — each individually sound, jointly
    // impossible. The default consistency table declares this MUTUAL_EXCLUSION.
    const investigator = new RecordingInvestigator([
      stageEntry("stage:order-1"),
      { ...stageEntry("eta:order-1"), value: "45min" },
    ]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
      soundCandidate("eta:order-1", "ORDER_ESTIMATED_ARRIVAL"),
    ]);
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    // Both were VALIDATED per-claim …
    expect(
      result.claims!.perClaim.every((c) => c.verdict === "VALIDATED"),
    ).toBe(true);
    // … but the SET is inconsistent → ESCALATE, neither rendered (never both).
    expect(result.claims!.terminal).toBe("ESCALATE");
    expect(result.claims!.renderable).toHaveLength(0);
    // The suppression record is proposition-free (carries only structural types).
    expect(result.claims!.consistency.suppressions.length).toBeGreaterThan(0);
    for (const s of result.claims!.consistency.suppressions) {
      expect(s.reason).toBe("MUTUAL_EXCLUSION_CONFLICT");
      expect(s).not.toHaveProperty("value");
    }
  });

  it("criterion 4: with NO claim pipeline wired, the 7-stage loop runs byte-equivalently and `claims` is ABSENT (no regression)", async () => {
    // No investigator, no claim planner → the legacy loop. The turn still
    // plans → adjudicates exactly once → dispatches → responds.
    const { adjudicator, executed, conductor } = makeBundle({});

    const result = await runTurn(conductor);

    expect(adjudicator.adjudicateCalls).toHaveLength(1); // once-per-turn intact
    expect(result.acted.kind).toBe("executed");
    expect(executed.count).toBe(1);
    expect(result.response.text).toContain("ok:");
    // The CLAIMS-VALIDATE result key is OMITTED on the legacy loop.
    expect(result.claims).toBeUndefined();
    expect("claims" in result).toBe(false);
  });

  it("criterion 5 (non-vacuity): disabling CLAIMS-VALIDATE (no claim planner) makes the validated-set UNOBSERVABLE → `claims` undefined", async () => {
    // INVESTIGATE alone (no claim planner) must NOT run CLAIMS-VALIDATE — the
    // pipeline is all-or-nothing, so a half-wired adopter never "passes" claims
    // unchecked. If the loop wrongly ran CLAIMS-VALIDATE anyway, `result.claims`
    // would be defined and these RED assertions would catch it.
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const { conductor } = makeBundle({ investigator /* no claimPlanner */ });

    const result = await runTurn(conductor);

    // INVESTIGATE still ran (the ledger is built) …
    expect(investigator.investigateCalls).toBe(1);
    // … but with no claim planner there is no validated set to render: the
    // disabling makes the criterion-2 outcomes unobservable (RED if it leaked).
    expect(result.claims).toBeUndefined();
  });

  it("R2b (a): a turn with an EMPTY candidate set (greeting/smalltalk) yields NO claims result, NOT a terminal UNKNOWN", async () => {
    // The full pipeline IS wired (investigator + claim planner + kernel deps),
    // but the planner proposes NOTHING — there is nothing to assert. UNKNOWN is
    // honest ignorance about a REQUESTED claim (SDD §I/§K), so an empty candidate
    // set must NOT be forced into a terminal claims-UNKNOWN. The stage returns
    // undefined and the turn carries no spurious claims result.
    //
    // NON-VACUITY: remove the `candidates.length === 0` guard in
    // claims-validate.ts and `result.claims` becomes the kernel's empty-set
    // result `{ perClaim: [], renderable: [], terminal: "UNKNOWN" }` — these
    // assertions go RED (claims is defined; terminal is UNKNOWN).
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([]); // greeting: no candidate claims
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    // The claim planner WAS consulted (the pipeline is fully wired) …
    expect(claimPlanner.calls).toBe(1);
    // … but with no candidates there is no claims result — no spurious UNKNOWN.
    expect(result.claims).toBeUndefined();
  });

  it("R2b (b): a NON-EMPTY candidate set is unchanged — still flows through runClaimsKernel to the normal validated result", async () => {
    // Guards the early-return: it must trigger ONLY on the empty set. A single
    // sound candidate must still reach the kernel and render normally (RENDER +
    // VALIDATED), proving the guard did not short-circuit the live path.
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
    ]);
    const { conductor } = makeBundle({ investigator, claimPlanner });

    const result = await runTurn(conductor);

    expect(claimPlanner.calls).toBe(1);
    expect(result.claims).toBeDefined();
    expect(result.claims!.terminal).toBe("RENDER");
    expect(result.claims!.perClaim).toEqual([
      { subject: ORDER, type: "ORDER_FULFILLMENT_STAGE", verdict: "VALIDATED" },
    ]);
  });

  it("criterion 5 (non-vacuity, dual): a wired pipeline that OMITS the kernel deps does NOT validate → `claims` undefined", async () => {
    // Same proof from the other missing dependency: investigator + claim planner
    // present, but `claimsKernel` deps absent → CLAIMS-VALIDATE must not run.
    const investigator = new RecordingInvestigator([stageEntry("stage:order-1")]);
    const claimPlanner = fixedClaimPlanner([
      soundCandidate("stage:order-1", "ORDER_FULFILLMENT_STAGE"),
    ]);
    const { conductor } = makeBundle({
      investigator,
      claimPlanner,
      withKernelDeps: false,
    });

    const result = await runTurn(conductor);

    expect(investigator.investigateCalls).toBe(1);
    expect(result.claims).toBeUndefined();
  });
});

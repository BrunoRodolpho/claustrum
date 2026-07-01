/**
 * Conductor per-turn freshness clock — R2a (Phase R · R2; SDD §G / §E).
 *
 * The defect this pins: the injected Claims-Kernel soundness deps carry a `now`
 * (a `number`) captured at BOOT. Before R2a the Conductor spread those deps into
 * every per-turn capsule unchanged, so `fresh(e)` was evaluated against the boot
 * time forever — stale cacheable evidence read as fresh on every later turn.
 *
 * R2a adds a `clock?: () => number` seam to `ConductorOptions` (default
 * `Date.now`) and rebuilds the soundness deps with a PER-TURN `now = clock()` at
 * the per-turn assembly site (`openCapsule`), so CLAIMS-VALIDATE evaluates
 * freshness against the CURRENT time each turn. The clock is a FUNCTION only in
 * claustrum's `ConductorOptions`; at the kernel boundary `now` stays a pure
 * `number` (SDD §R kernel purity — the seam lives in the loop, never the kernel).
 *
 * Mocks only: in-memory test-doubles + the REAL published `@adjudicate/core`
 * claims runtime (real `EvidenceLedger` / `runClaimsKernel`). No live model / DB.
 *
 * Non-vacuity (stated per acceptance): each assertion goes RED if the per-turn
 * rebuild is reverted to the boot-frozen spread (`claimsKernel: options.claimsKernel`).
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
  type ClaimsKernelDepsForTurn,
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

const CUSTOMER = "cust-clock";
const ORDER = "order-1";

// ── Evidence fixtures ────────────────────────────────────────────────────────

/** A present + TRUSTED cacheable entry whose freshness (`now - fetchedAt <= ttl`)
 *  depends on the clock — the only freshness tier `now` participates in. */
function cacheableEntry(key: string, fetchedAt: number): EvidenceEntryInput {
  return {
    key,
    value: "out_for_delivery",
    source: "OrderProjection",
    fetchedAt,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  };
}

/** A candidate requiring `key` under a finite cacheable ttl → its verdict flips
 *  VALIDATED↔UNKNOWN purely on whether `now - fetchedAt <= ttl` at validate time. */
function cacheableCandidate(
  key: string,
  type: string,
  ttl: number,
): CandidateClaim {
  return {
    soundness: {
      requiredEvidence: [
        {
          key,
          ownershipPolicy: "required",
          freshnessPolicy: { kind: "cacheable", ttl },
          sourceIntegrity: "trusted_service",
          provenancePolicy: "preserve",
        },
      ],
      minSourceIntegrity: "trusted_service",
      kind: "read_claim",
      actor: { customerId: CUSTOMER },
      resources: { [key]: ORDER },
      // W6 falsifier-completeness eligibility (≥ @adjudicate/core 1.8.0): a claim
      // VALIDATEs only if its type ENUMERATED how it could be falsified. The
      // falsifier key is never recorded in these fixtures → the runtime arm never
      // fires → the verdict still flips purely on freshness (the axis under test).
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

/** A `must_read_this_turn` entry — freshness here is clock-INDEPENDENT (it only
 *  requires `sourceMode === "live"`), used to prove the default path is unchanged. */
function liveEntry(key: string, fetchedAt: number): EvidenceEntryInput {
  return {
    key,
    value: "out_for_delivery",
    source: "OrderProjection",
    fetchedAt,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  };
}

function liveCandidate(key: string, type: string): CandidateClaim {
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
      // W6 falsifier-completeness eligibility (≥ @adjudicate/core 1.8.0) — see
      // cacheableCandidate. Falsifier key never recorded → never fires.
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

// ── Ports (mocks) ────────────────────────────────────────────────────────────

function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const envelope = buildEnvelope({
        kind: "demo.echo",
        payload: { text: state.perception.text },
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
        createdAt: new Date().toISOString(),
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

function makeTool(
  executed: { count: number },
): ToolDefinition<{ text?: string }, unknown> {
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
      tenant: {
        tenantId: "t",
        displayName: "T",
        locale: "pt-BR",
        environment: "dev",
      },
      state: { balanceOk: true },
      policy: {},
    };
  },
};

class RecordingInvestigator implements InvestigatorPort {
  constructor(private readonly entries: ReadonlyArray<EvidenceEntryInput>) {}
  async investigate(input: {
    readonly ledger: EvidenceLedger;
    readonly customerId: string;
  }): Promise<void> {
    for (const e of this.entries) input.ledger.record(e);
  }
}

function fixedClaimPlanner(
  candidates: ReadonlyArray<CandidateClaim>,
): ClaimPlannerPort {
  return {
    async propose() {
      return candidates;
    },
  };
}

interface BundleOpts {
  /** Boot-time `now` baked into the injected soundness deps (the FROZEN value). */
  readonly bootNow: number;
  /** Per-turn clock seam; omit to exercise the `Date.now` default. */
  readonly clock?: () => number;
  readonly investigator?: InvestigatorPort;
  readonly claimPlanner?: ClaimPlannerPort;
  /** Per-turn Claims-Kernel deps builder (the W5b conductor seam). */
  readonly claimsKernelDepsForTurn?: ClaimsKernelDepsForTurn;
}

function makeBundle(opts: BundleOpts) {
  const claimsKernel: ClaimsKernelDeps = {
    soundness: {
      owns: () => true,
      outcomeConfirmed: () => true,
      // The FROZEN boot value. R2a must rebuild this per turn from `clock()`.
      now: opts.bootNow,
    },
  };
  const executed = { count: 0 };
  const tools = createToolRegistry();
  tools.register(makeTool(executed));
  const conductor = createConductor({
    adjudicator: new StubAdjudicator(),
    memory: new InMemoryMemoryProvider(),
    grounding: new EmptyGroundingProvider(),
    planner: makePlanner(),
    responder: makeResponder(),
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: new RecordingTelemetrySink(),
    session: new InMemorySessionStore(),
    tools,
    channels: [new WebChannelStub()],
    tenantResolver,
    claimsKernel,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.investigator !== undefined
      ? { investigator: opts.investigator }
      : {}),
    ...(opts.claimPlanner !== undefined
      ? { claimPlanner: opts.claimPlanner }
      : {}),
    ...(opts.claimsKernelDepsForTurn !== undefined
      ? { claimsKernelDepsForTurn: opts.claimsKernelDepsForTurn }
      : {}),
  });
  return { conductor, executed };
}

function inbound(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: CUSTOMER,
    conversationId: "conv-clock",
    text,
    receivedAt: new Date().toISOString(),
  };
}

async function runTurn(conductor: ReturnType<typeof makeBundle>["conductor"]) {
  const msg = inbound("por que meu pedido está atrasado?");
  const capsule = await conductor.openCapsule({
    channel: "web",
    customerId: CUSTOMER,
    inbound: msg,
  });
  const result = await handleTurn(capsule, msg);
  await conductor.closeCapsule(capsule);
  return result;
}

describe("Conductor per-turn freshness clock (R2a / SDD §G/§E)", () => {
  it("(a) `clock` defaults to `Date.now` — an unspecified clock yields a CURRENT `now`, not the boot value", async () => {
    const BOOT = 1_000; // a far-past, obviously-stale boot timestamp
    const { conductor } = makeBundle({ bootNow: BOOT /* no clock → default */ });

    const before = Date.now();
    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("hi"),
    });
    const after = Date.now();

    const now = capsule.claimsKernel!.soundness.now;
    // The default clock is the live wall clock, NOT the frozen boot value.
    expect(now).not.toBe(BOOT);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);

    await conductor.closeCapsule(capsule);
  });

  it("(b) two successive turns see DIFFERENT `now` in the soundness deps (boot value is NOT reused)", async () => {
    const BOOT = 1_000;
    let tick = 10_000;
    const clock = () => (tick += 1_000); // advancing: 11000, then 12000
    const { conductor } = makeBundle({ bootNow: BOOT, clock });

    const c1 = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("turn 1"),
    });
    const now1 = c1.claimsKernel!.soundness.now;
    await conductor.closeCapsule(c1);

    const c2 = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("turn 2"),
    });
    const now2 = c2.claimsKernel!.soundness.now;
    await conductor.closeCapsule(c2);

    // The clock is read once per turn → each turn sees its own advancing value.
    expect(now1).toBe(11_000);
    expect(now2).toBe(12_000);
    expect(now1).not.toBe(now2);
    // …and neither turn reused the boot-frozen value (the defect).
    // Non-vacuity: revert the rebuild to `claimsKernel: options.claimsKernel`
    // → now1 === now2 === BOOT → both `toBe` and these `not.toBe` go RED.
    expect(now1).not.toBe(BOOT);
    expect(now2).not.toBe(BOOT);
  });

  it("(c) cacheable evidence FRESH at boot but STALE at turn-time validates as STALE (clock drives `fresh(e)`)", async () => {
    const T0 = 100_000; // fetchedAt
    const TTL = 60_000; // staleness window
    const key = "stage:order-1";
    const investigator = new RecordingInvestigator([cacheableEntry(key, T0)]);
    const claimPlanner = fixedClaimPlanner([
      cacheableCandidate(key, "ORDER_FULFILLMENT_STAGE", TTL),
    ]);

    // STALE turn: boot `now = T0` would judge the entry FRESH (age 0), but the
    // per-turn clock is T0+TTL+1 → age TTL+1 > TTL → STALE. If the code reused
    // the boot value the verdict would wrongly be VALIDATED — so this is RED
    // unless the per-turn rebuild is in effect.
    const stale = makeBundle({
      bootNow: T0,
      clock: () => T0 + TTL + 1,
      investigator,
      claimPlanner,
    });
    const staleResult = await runTurn(stale.conductor);
    expect(staleResult.claims!.perClaim).toEqual([
      { subject: ORDER, type: "ORDER_FULFILLMENT_STAGE", verdict: "UNKNOWN" },
    ]);
    expect(staleResult.claims!.renderable).toHaveLength(0);

    // CONTROL — identical fixture and identical boot `now = T0`, only the clock
    // differs (T0, within ttl) → VALIDATED. Proves the fixture is genuinely
    // fresh-at-boot and that the verdict flip above is driven by `clock()`,
    // not by the fixture or the boot value.
    const fresh = makeBundle({
      bootNow: T0,
      clock: () => T0,
      investigator: new RecordingInvestigator([cacheableEntry(key, T0)]),
      claimPlanner: fixedClaimPlanner([
        cacheableCandidate(key, "ORDER_FULFILLMENT_STAGE", TTL),
      ]),
    });
    const freshResult = await runTurn(fresh.conductor);
    expect(freshResult.claims!.perClaim[0]!.verdict).toBe("VALIDATED");
    expect(freshResult.claims!.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("(d) default behavior unchanged — a clock-independent `must_read_this_turn` claim still validates with NO clock injected", async () => {
    const key = "stage:order-1";
    const investigator = new RecordingInvestigator([liveEntry(key, 42)]);
    const claimPlanner = fixedClaimPlanner([
      liveCandidate(key, "ORDER_FULFILLMENT_STAGE"),
    ]);
    // No `clock` → default `Date.now`. `must_read_this_turn` freshness is
    // clock-independent (only `sourceMode === "live"`), so the verdict is stable.
    const { conductor } = makeBundle({
      bootNow: Date.now(),
      investigator,
      claimPlanner,
    });

    const result = await runTurn(conductor);

    expect(result.claims!.terminal).toBe("RENDER");
    expect(result.claims!.perClaim[0]!.verdict).toBe("VALIDATED");
    expect(result.claims!.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("(e) the kernel boundary stays pure — the `now` threaded into the soundness deps is a `number`, not a function", async () => {
    const { conductor } = makeBundle({
      bootNow: 5_000,
      clock: () => 7_777,
    });
    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("hi"),
    });

    // The function lives ONLY in ConductorOptions; the kernel receives a number.
    expect(typeof capsule.claimsKernel!.soundness.now).toBe("number");
    expect(capsule.claimsKernel!.soundness.now).toBe(7_777);

    await conductor.closeCapsule(capsule);
  });

  it("(f) FRESHNESS FLOOR (fix 1): a SAME-TURN live read stamped AFTER the turn `now` is FRESH (not future-stale) → VALIDATEs", async () => {
    // The clock-ordering defect: the Conductor captures the per-turn `now` at
    // openCapsule (turn START); the investigator then stamps the live read's
    // `fetchedAt = Date.now()` a few ms LATER (handle-turn step 4b). So a real
    // same-turn first-party read carries `fetchedAt > now` → the kernel's correct
    // negative-age guard (`age >= 0`) rejects it → a VALID live read demotes to
    // UNKNOWN. Here the clock is T_CLOCK and the read is stamped T_CLOCK+OFFSET
    // (the future-relative-to-turn-start stamp), under a CACHEABLE policy so age
    // participates. The CLAIMS-VALIDATE per-turn floor raises `now` up to the
    // newest live `fetchedAt` so age ≥ 0 → FRESH → VALIDATED.
    const T_CLOCK = 100_000;
    const OFFSET = 5; // the read is stamped a few ms after the turn `now`
    const TTL = 60_000;
    const key = "stage:order-1";
    const investigator = new RecordingInvestigator([
      cacheableEntry(key, T_CLOCK + OFFSET),
    ]);
    const claimPlanner = fixedClaimPlanner([
      cacheableCandidate(key, "ORDER_FULFILLMENT_STAGE", TTL),
    ]);
    const { conductor } = makeBundle({
      bootNow: T_CLOCK,
      clock: () => T_CLOCK,
      investigator,
      claimPlanner,
    });

    const result = await runTurn(conductor);

    // Non-vacuity: REMOVE the floor in claims-validate.ts and the same-turn read's
    // `fetchedAt` (T_CLOCK+OFFSET) is in the FUTURE of `now` (T_CLOCK) → negative
    // age → UNKNOWN → this assertion goes RED. With the floor, `now` is raised to
    // T_CLOCK+OFFSET → age 0 → VALIDATED.
    expect(result.claims!.perClaim[0]!.verdict).toBe("VALIDATED");
    expect(result.claims!.terminal).toBe("RENDER");
    expect(result.claims!.renderable.map((c) => c.type)).toEqual([
      "ORDER_FULFILLMENT_STAGE",
    ]);
  });

  it("(g) FRESHNESS FLOOR is live-only: a genuinely stale CACHED read (old cache `fetchedAt`) is NOT rescued → STALE/UNKNOWN", async () => {
    // The floor must only RAISE `now` over `sourceMode === "live"` reads, so it can
    // never mask a genuinely stale CACHED entry. Here the entry is `sourceMode:
    // "cache"` with an OLD `fetchedAt` (T0), the clock is far ahead (T0+TTL+1), and
    // there is NO live read to floor against → `now` stays at the clock → age
    // TTL+1 > TTL → STALE → UNKNOWN. (Proves the floor cannot launder cache.)
    const T0 = 100_000;
    const TTL = 60_000;
    const key = "stage:order-1";
    const cachedEntry: EvidenceEntryInput = {
      key,
      value: "out_for_delivery",
      source: "OrderProjection",
      fetchedAt: T0,
      sourceMode: "cache",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    };
    const investigator = new RecordingInvestigator([cachedEntry]);
    const claimPlanner = fixedClaimPlanner([
      cacheableCandidate(key, "ORDER_FULFILLMENT_STAGE", TTL),
    ]);
    const { conductor } = makeBundle({
      bootNow: T0,
      clock: () => T0 + TTL + 1,
      investigator,
      claimPlanner,
    });

    const result = await runTurn(conductor);

    expect(result.claims!.perClaim[0]!.verdict).toBe("UNKNOWN");
    expect(result.claims!.renderable).toHaveLength(0);
  });
});

// ── Per-turn OWNS (fix 2 — the W5b conductor seam) ────────────────────────────

describe("Conductor per-turn owns (W5b seam / SDD §E C1 · Inv 2)", () => {
  /** A per-turn deps builder that rebuilds `owns` from the owner-scoped reads that
   *  returned PRESENT this turn — exactly the IDOR-safe shape the ibatexas adopter
   *  wires: the owned set is derived ONLY from present ledger entries (a forged /
   *  cross-owner read is absent → never owned), keyed by the resource id SUFFIX of
   *  the per-resource ledger key. `customerId` is the authenticated principal. */
  const buildOwnsFromLedger: ClaimsKernelDepsForTurn = ({ ledger, base }) => {
    const owned = new Set<string>();
    for (const key of ledger.keys()) {
      if (ledger.resolve(key).state !== "present") continue;
      const idx = key.indexOf(":");
      if (idx >= 0) owned.add(key.slice(idx + 1));
    }
    return {
      ...base,
      soundness: {
        ...base.soundness,
        owns: (_actor, resource) =>
          typeof resource === "string" && owned.has(resource),
      },
    };
  };

  it("(a) the legit OWNER gets owns=true for their present resource → the owner-scoped claim VALIDATEs", async () => {
    const key = "stage:order-1"; // resource id suffix = "order-1" = ORDER
    const investigator = new RecordingInvestigator([liveEntry(key, 42)]);
    const claimPlanner = fixedClaimPlanner([
      liveCandidate(key, "ORDER_FULFILLMENT_STAGE"),
    ]);
    // The PROCESS-WIDE deps fail closed (owns → false); the per-turn builder is
    // what supplies the real owner attribution from this turn's present reads.
    const { conductor } = makeBundle({
      bootNow: 42,
      investigator,
      claimPlanner,
      claimsKernelDepsForTurn: buildOwnsFromLedger,
    });

    const result = await runTurn(conductor);

    expect(result.claims!.perClaim[0]!.verdict).toBe("VALIDATED");
    expect(result.claims!.terminal).toBe("RENDER");
  });

  it("(b) a NON-owner gets owns=false → C1 ownership REFUSED (a denial, not mere absence — Inv 2)", async () => {
    // The candidate's required key IS present + fresh this turn, so present(e) and
    // fresh(e) pass; the per-turn builder returns `owns → false` for the resource
    // (this customer is not the owner). C1 ownership then DOMINATES → REFUSED
    // ("no owner" ≠ "any owner"); the claim is never validated, nothing renders.
    const key = "stage:order-1";
    const investigator = new RecordingInvestigator([liveEntry(key, 42)]);
    const claimPlanner = fixedClaimPlanner([
      liveCandidate(key, "ORDER_FULFILLMENT_STAGE"),
    ]);
    const denyOwns: ClaimsKernelDepsForTurn = ({ base }) => ({
      ...base,
      soundness: { ...base.soundness, owns: () => false },
    });
    const { conductor } = makeBundle({
      bootNow: 42,
      investigator,
      claimPlanner,
      claimsKernelDepsForTurn: denyOwns,
    });

    const result = await runTurn(conductor);

    expect(result.claims!.perClaim[0]!.verdict).toBe("REFUSED");
    expect(result.claims!.renderable).toHaveLength(0);
  });

  it("(c) IDOR proof — owns is built from the present-read LEDGER + the AUTHENTICATED customerId, never a model/session id; a cross-owner resource (absent read) is never owned", async () => {
    // Assert the seam received the AUTHENTICATED customerId + the threaded ledger
    // (not a model/session id). The candidate binds resource "order-1" whose
    // owner-scoped read did NOT return present this turn (only a DIFFERENT order
    // was read) — so the ledger-derived owned set never contains it → no "any
    // owner" leak; the claim degrades safe (non-VALIDATED), nothing renders.
    const candidateKey = "stage:order-1"; // claim binds resource "order-1"
    const otherOwnersRead = "stage:order-OTHER"; // the only present read this turn
    let sawCustomerId: string | undefined;
    const recordingBuilder: ClaimsKernelDepsForTurn = (args) => {
      sawCustomerId = args.customerId;
      return buildOwnsFromLedger(args);
    };
    const investigator = new RecordingInvestigator([
      liveEntry(otherOwnersRead, 42),
    ]);
    const claimPlanner = fixedClaimPlanner([
      liveCandidate(candidateKey, "ORDER_FULFILLMENT_STAGE"),
    ]);
    const { conductor } = makeBundle({
      bootNow: 42,
      investigator,
      claimPlanner,
      claimsKernelDepsForTurn: recordingBuilder,
    });

    const result = await runTurn(conductor);

    expect(sawCustomerId).toBe(CUSTOMER); // authenticated principal, not a model id
    expect(result.claims!.perClaim[0]!.verdict).not.toBe("VALIDATED");
    expect(result.claims!.renderable).toHaveLength(0);
  });
});

/**
 * Parked-resume — the audit invariant (P0-B / LogicReviewer-004).
 *
 * `handleTurn` must RESUME a parked confirmation/deferral by RE-ADJUDICATING
 * it, never by dispatching the parked envelope directly on confirm. Every
 * resumed EXECUTE side-effect is backed by a fresh audited Decision; a
 * confirmation that arrives after the state changed is re-evaluated and can
 * REFUSE (money-safety). These tests pin that behavior against the in-memory
 * session store + the StubAdjudicator (which records every `resume` call so we
 * can prove re-adjudication happened, not dispatch-on-confirm).
 *
 * The kernel's actual REQUEST_CONFIRMATION→EXECUTE flip + the single
 * AuditRecord-before-dispatch are proven separately against the production
 * `buildAdjudicator` + a capturing sink (ibatexas parked-resume-audit.test.ts).
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type CapabilityId,
  type ChannelMessage,
  type IntentKind,
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

const FIXED_NOW = "2026-05-18T12:00:00.000Z";
const CUSTOMER = "cust-resume";
const SESSION_ID = `web:${CUSTOMER}`;

function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const kind = state.perception.text.includes("danger") ? "danger" : "demo.echo";
      const envelope = buildEnvelope({
        kind,
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
      if (input.decision.kind === "REFUSE") return { text: input.decision.refusal.userFacing };
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

function makeBundle() {
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
  });
  return { adjudicator, session, channel, executed, conductor };
}

function inbound(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: CUSTOMER,
    conversationId: "conv-resume",
    text,
    receivedAt: FIXED_NOW,
  };
}

/** Build a parked-confirmation envelope and seed it into the session store. */
async function seedParkedConfirmation(
  session: InMemorySessionStore,
  kind: string,
): Promise<IntentEnvelope> {
  await session.load(CUSTOMER, "web"); // create the session row
  const env = buildEnvelope({
    kind,
    payload: { amount: 5000 },
    actor: { principal: "llm", sessionId: SESSION_ID },
    taint: "TRUSTED",
    nonce: `parked-${kind}`,
    createdAt: FIXED_NOW,
  }) as IntentEnvelope;
  await session.parkPendingConfirmation(SESSION_ID, env, env.intentHash, "Confirma?");
  return env;
}

describe("handleTurn — parked-resume audit invariant", () => {
  it("REQUEST_CONFIRMATION parks the envelope and runs NO tool (no dispatch)", async () => {
    // The dispatch matrix parks on REQUEST_CONFIRMATION; the tool never runs
    // until a later turn resumes it. Drive it directly through the dispatcher.
    const { dispatchDecision } = await import("../src/index.js");
    const { createToolRegistry: mkReg } = await import("../src/index.js");
    const executed = { count: 0 };
    const reg = mkReg();
    reg.register(makeTool(executed));
    const env = buildEnvelope({
      kind: "demo.echo",
      payload: {},
      actor: { principal: "llm", sessionId: SESSION_ID },
      taint: "TRUSTED",
      nonce: "park-only",
      createdAt: FIXED_NOW,
    }) as IntentEnvelope;
    const session = new InMemorySessionStore();
    await session.load(CUSTOMER, "web");
    const loadedSession = await session.load(CUSTOMER, "web");
    const capsule = {
      tools: reg,
      session,
      loadedSession,
    } as unknown as Parameters<typeof dispatchDecision>[2];
    const acted = await dispatchDecision(
      { kind: "REQUEST_CONFIRMATION", prompt: "Confirma?", basis: [] },
      { envelopes: [env] },
      capsule,
    );
    expect(acted.kind).toBe("awaiting_confirmation");
    expect(executed.count).toBe(0); // parked, NOT dispatched
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(1);
  });

  it("confirm reply RE-ADJUDICATES (not dispatch-on-confirm), EXECUTEs, dispatches, unparks", async () => {
    const { adjudicator, session, channel, executed, conductor } = makeBundle();
    const parked = await seedParkedConfirmation(session, "demo.echo");
    channel.matchToParkedImpl = (_e, s) => ({
      parked: s.pendingConfirmations[0]!,
      userResolution: "confirm",
    });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("sim"),
    });
    const result = await handleTurn(capsule, inbound("sim"));
    await conductor.closeCapsule(capsule);

    // RE-ADJUDICATED: resume was called with the parked envelope + a receipt.
    expect(adjudicator.resumeCalls).toHaveLength(1);
    expect(adjudicator.resumeCalls[0]!.envelope.intentHash).toBe(parked.intentHash);
    expect(adjudicator.resumeCalls[0]!.receipt?.intentHash).toBe(parked.intentHash);
    // NOT a fresh plan+adjudicate: the normal adjudicate verb was not invoked.
    expect(adjudicator.adjudicateCalls).toHaveLength(0);
    // EXECUTE → dispatched exactly once.
    expect(result.decision.kind).toBe("EXECUTE");
    expect(result.acted.kind).toBe("executed");
    expect(executed.count).toBe(1);
    // Unparked: the resolved confirmation is gone.
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(0);
  });

  it("confirm reply whose re-adjudication now REFUSEs does NOT dispatch (money-safety)", async () => {
    const { adjudicator, session, channel, executed, conductor } = makeBundle();
    // A `danger`-kind parked envelope models "state changed → kernel now refuses".
    const parked = await seedParkedConfirmation(session, "danger");
    channel.matchToParkedImpl = (_e, s) => ({
      parked: s.pendingConfirmations[0]!,
      userResolution: "confirm",
    });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("sim"),
    });
    const result = await handleTurn(capsule, inbound("sim"));
    await conductor.closeCapsule(capsule);

    expect(adjudicator.resumeCalls).toHaveLength(1); // re-adjudicated
    expect(result.decision.kind).toBe("REFUSE");
    expect(result.acted.kind).toBe("refused");
    expect(executed.count).toBe(0); // NO side-effect on a refused resume
    // Resolved (the confirmation can't be honored) → unparked.
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations.some((p) => p.envelope.intentHash === parked.intentHash)).toBe(false);
  });

  it("a deferred envelope whose condition is satisfied resumes (re-adjudicate, no receipt)", async () => {
    const { adjudicator, session, executed, conductor } = makeBundle();
    await session.load(CUSTOMER, "web");
    const env = buildEnvelope({
      kind: "demo.echo",
      payload: {},
      actor: { principal: "llm", sessionId: SESSION_ID },
      taint: "TRUSTED",
      nonce: "deferred-1",
      createdAt: FIXED_NOW,
    }) as IntentEnvelope;
    // deferUntil already in the PAST relative to the inbound → condition met.
    await session.parkDeferred(SESSION_ID, env, "manual", "2026-05-18T00:00:00.000Z", 1000);

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("any later message"),
    });
    const result = await handleTurn(capsule, inbound("any later message"));
    await conductor.closeCapsule(capsule);

    expect(adjudicator.resumeCalls).toHaveLength(1);
    expect(adjudicator.resumeCalls[0]!.envelope.intentHash).toBe(env.intentHash);
    expect(adjudicator.resumeCalls[0]!.receipt).toBeUndefined(); // deferred → no receipt
    expect(result.acted.kind).toBe("executed");
    expect(executed.count).toBe(1);
    const after = await session.load(CUSTOMER, "web");
    expect(after.deferredEnvelopes).toHaveLength(0); // unparked
  });

  it("deny reply abandons (unparks) the envelope and re-adjudicates nothing", async () => {
    const { adjudicator, session, channel, conductor } = makeBundle();
    const parked = await seedParkedConfirmation(session, "demo.echo");
    channel.matchToParkedImpl = (_e, s) => ({
      parked: s.pendingConfirmations[0]!,
      userResolution: "deny",
    });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("não, cancela"),
    });
    await handleTurn(capsule, inbound("não, cancela"));
    await conductor.closeCapsule(capsule);

    expect(adjudicator.resumeCalls).toHaveLength(0); // nothing re-adjudicated
    expect(adjudicator.adjudicateCalls).toHaveLength(1); // fell through to normal loop
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations.some((p) => p.envelope.intentHash === parked.intentHash)).toBe(false);
  });

  it("defer reply re-parks the envelope as deferred and re-adjudicates nothing", async () => {
    const { adjudicator, session, channel, conductor } = makeBundle();
    const parked = await seedParkedConfirmation(session, "demo.echo");
    channel.matchToParkedImpl = (_e, s) => ({
      parked: s.pendingConfirmations[0]!,
      userResolution: "defer",
      deferPhrase: "amanhã",
    });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("sim, amanhã"),
    });
    await handleTurn(capsule, inbound("sim, amanhã"));
    await conductor.closeCapsule(capsule);

    expect(adjudicator.resumeCalls).toHaveLength(0);
    const after = await session.load(CUSTOMER, "web");
    expect(after.pendingConfirmations).toHaveLength(0); // moved out of pending
    expect(after.deferredEnvelopes).toHaveLength(1); // re-parked as deferred
    expect(after.deferredEnvelopes[0]!.envelope.intentHash).toBe(parked.intentHash);
  });

  it("no parked match → the normal cognitive loop runs (byte-equivalent), no resume", async () => {
    const { adjudicator, channel, executed, conductor } = makeBundle();
    channel.matchToParkedImpl = null; // fresh utterance

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("adiciona uma costela"),
    });
    const result = await handleTurn(capsule, inbound("adiciona uma costela"));
    await conductor.closeCapsule(capsule);

    // Normal path: planner → adjudicate (exactly once), resume untouched.
    expect(adjudicator.resumeCalls).toHaveLength(0);
    expect(adjudicator.adjudicateCalls).toHaveLength(1);
    expect(result.acted.kind).toBe("executed");
    expect(executed.count).toBe(1);
  });
});

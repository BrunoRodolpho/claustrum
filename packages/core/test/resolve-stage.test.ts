/**
 * Resolve stage (plan → RESOLVE → submit) — the pre-adjudication contract.
 *
 * When a `ResolverPort` is wired, `handleTurn` must, between PLAN and SUBMIT:
 *   1. replace the planner's envelopes with the resolver's RESOLVED envelopes,
 *      so the resolved payload is what gets adjudicated AND dispatched (audited
 *      == executed);
 *   2. adjudicate each envelope against the resolver's per-envelope SystemState
 *      (superseding the turn's resolution.state).
 *
 * When NO resolver is wired, behavior is unchanged: the planner's envelopes are
 * adjudicated as-is against resolution.state.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  deriveIntentHash,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type CapabilityId,
  type ChannelMessage,
  type IntentKind,
  type Plan,
  type PlannerPort,
  type ResolverPort,
  type ResponderPort,
  type SystemState,
  type TenantResolver,
  type ToolDefinition,
} from "../src/index.js";
import type {
  Adjudicator,
  AuditVerification,
  OutcomeFilter,
  OutcomeRow,
  PolicyBundle,
} from "../src/ports/adjudicator.js";
import type { AuditRecord } from "@adjudicate/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  WebChannelStub,
} from "../src/test-doubles/index.js";

const FIXED_NOW = "2026-06-07T12:00:00.000Z";
const CUSTOMER = "cust-resolve";
const TENANT_STATE = { ctx: { source: "tenant-resolver" } };

/** Adjudicator that records the (envelope, state) it was asked to decide on. */
class RecordingAdjudicator implements Adjudicator {
  public readonly calls: Array<{
    readonly envelope: IntentEnvelope;
    readonly state: SystemState;
  }> = [];
  public readonly planCalls: Array<{
    readonly envelopes: ReadonlyArray<IntentEnvelope>;
    readonly state: SystemState;
    readonly perEnvelopeStates: ReadonlyArray<SystemState> | undefined;
  }> = [];

  async adjudicate(
    envelope: IntentEnvelope,
    state: SystemState,
    _policy: PolicyBundle,
  ): Promise<Decision> {
    void _policy;
    this.calls.push({ envelope, state });
    return { kind: "EXECUTE", basis: [] };
  }

  async adjudicatePlan(
    envelopes: ReadonlyArray<IntentEnvelope>,
    state: SystemState,
    _policy: PolicyBundle,
    perEnvelopeStates?: ReadonlyArray<SystemState>,
  ): Promise<Decision> {
    void _policy;
    this.planCalls.push({ envelopes, state, perEnvelopeStates });
    return { kind: "EXECUTE", basis: [] };
  }

  async replayEnvelopesByCustomerId(): Promise<ReadonlyArray<AuditRecord>> {
    return [];
  }
  streamAuditByIntentHashPrefix(): AsyncIterable<AuditRecord> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<AuditRecord> {
        return { async next() { return { value: undefined, done: true }; } };
      },
    };
  }
  async getOutcomes(_f: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>> {
    void _f;
    return [];
  }
  verifyAuditRecord(_r: AuditRecord): AuditVerification {
    void _r;
    return { ok: true };
  }
}

/** Planner that proposes ONE envelope with an UNRESOLVED natural-language payload. */
function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const envelope = buildEnvelope({
        kind: "demo.echo",
        payload: { item: "linguiça" },
        actor: { principal: "llm", sessionId: state.conversationId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
        createdAt: FIXED_NOW,
      }) as IntentEnvelope;
      return { envelopes: [envelope], rationale: "nl planner" };
    },
  };
}

/** Resolver that rewrites the NL payload → resolved id and returns per-envelope state. */
function makeResolver(): ResolverPort {
  return {
    async resolve({ plan, customerId }) {
      return plan.envelopes.map((env) => ({
        envelope: buildEnvelope({
          kind: env.kind,
          payload: { ...(env.payload as object), variantId: "variant-123" },
          actor: env.actor,
          taint: env.taint,
          nonce: `${env.nonce ?? "n"}-resolved`,
          createdAt: FIXED_NOW,
        }) as IntentEnvelope,
        state: { ctx: { resolvedFor: customerId, variantId: "variant-123" } },
      }));
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(): Promise<{ text: string }> {
      return { text: "ok" };
    },
  };
}

function makeTool(seen: Array<unknown>): ToolDefinition<{ item?: string; variantId?: string }, unknown> {
  return {
    id: "demo.echo.v1",
    capability: "demo.echo" as CapabilityId,
    intentKind: "demo.echo" as IntentKind,
    description: "echo",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "low",
    async execute(input) {
      seen.push(input);
      return { echoed: input };
    },
  };
}

const tenantResolver: TenantResolver = {
  async resolve() {
    return {
      tenant: { tenantId: "t", displayName: "T", locale: "pt-BR", environment: "dev" },
      state: TENANT_STATE,
      policy: {},
    };
  },
};

function makeBundle(opts: { withResolver: boolean }) {
  const adjudicator = new RecordingAdjudicator();
  const toolSeen: Array<unknown> = [];
  const tools = createToolRegistry();
  tools.register(makeTool(toolSeen));
  const conductor = createConductor({
    adjudicator,
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
    ...(opts.withResolver ? { resolver: makeResolver() } : {}),
  });
  return { adjudicator, toolSeen, conductor };
}

function inbound(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: CUSTOMER,
    conversationId: "conv-resolve",
    text,
    receivedAt: FIXED_NOW,
  };
}

describe("handleTurn — resolve stage", () => {
  it("adjudicates the RESOLVED envelope against the per-envelope state, and dispatches it", async () => {
    const { adjudicator, toolSeen, conductor } = makeBundle({ withResolver: true });
    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("quero linguiça"),
    });
    await handleTurn(capsule, inbound("quero linguiça"));

    // Single envelope → adjudicate() (not adjudicatePlan).
    expect(adjudicator.calls).toHaveLength(1);
    const call = adjudicator.calls[0]!;
    // 1. The RESOLVED payload is what got adjudicated.
    expect((call.envelope.payload as { variantId?: string }).variantId).toBe("variant-123");
    // 2. The per-envelope state superseded the tenant resolution.state.
    expect(call.state).toEqual({ ctx: { resolvedFor: CUSTOMER, variantId: "variant-123" } });
    // 3. The resolved envelope's intentHash is canonical (kernel re-derivation passes).
    expect(deriveIntentHash(call.envelope)).toBe(call.envelope.intentHash);
    // 4. Audited == executed: dispatch ran the tool with the RESOLVED payload.
    expect(toolSeen).toHaveLength(1);
    expect((toolSeen[0] as { variantId?: string }).variantId).toBe("variant-123");

    await conductor.closeCapsule(capsule);
  });

  it("without a resolver, adjudicates the planner's envelope as-is against resolution.state", async () => {
    const { adjudicator, toolSeen, conductor } = makeBundle({ withResolver: false });
    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: CUSTOMER,
      inbound: inbound("quero linguiça"),
    });
    await handleTurn(capsule, inbound("quero linguiça"));

    expect(adjudicator.calls).toHaveLength(1);
    const call = adjudicator.calls[0]!;
    // Unresolved payload (no variantId) reaches the kernel.
    expect((call.envelope.payload as { variantId?: string }).variantId).toBeUndefined();
    // Legacy: the turn's resolution.state is used.
    expect(call.state).toBe(TENANT_STATE);
    // Tool ran with the original payload.
    expect((toolSeen[0] as { item?: string }).item).toBe("linguiça");

    await conductor.closeCapsule(capsule);
  });
});

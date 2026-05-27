/**
 * Test-only conductor module — referenced by replay.test.ts and
 * conformance.test.ts. Exports `createConductor` as the CLI loader
 * expects.
 */

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import {
  createConductor as createConductorCore,
  createToolRegistry,
  type CapabilityId,
  type Conductor,
  type DraftResponse,
  type ExplainerPort,
  type HandoffPort,
  type IntentKind,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type TenantResolver,
  type ToolDefinition,
} from "@claustrum/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "@claustrum/core/test-doubles";

const CAP = "demo.echo" as CapabilityId;
const KIND = "demo.echo" as IntentKind;

function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const kind = state.perception.text.includes("danger") ? "danger" : "demo.echo";
      const envelope = buildEnvelope({
        kind,
        payload: { text: state.perception.text },
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `n-${state.turnId}`,
      }) as IntentEnvelope;
      return { envelopes: [envelope] };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      if (input.decision.kind === "REFUSE") return { text: input.decision.refusal.userFacing };
      return { text: `Echo: ${input.cognition.perception.text}` };
    },
  };
}

function makeExplainer(): ExplainerPort {
  return { render: (r) => r.userFacing };
}

function makeHandoff(): HandoffPort {
  return {
    async queue(): Promise<void> {
      /* no-op */
    },
  };
}

function makeTenantResolver(): TenantResolver {
  return {
    async resolve() {
      return {
        tenant: {
          tenantId: "t",
          displayName: "Test",
          locale: "en-US",
          environment: "dev" as const,
        },
        state: {},
        policy: {},
      };
    },
  };
}

function makeEchoTool(): ToolDefinition<{ text: string }, { echoed: string }> {
  return {
    id: "demo.echo.v1",
    capability: CAP,
    description: "echo",
    inputSchema: {},
    outputSchema: {},
    intentKind: KIND,
    riskLevel: "low",
    async execute(input): Promise<{ echoed: string }> {
      return { echoed: input.text };
    },
  };
}

export function createConductor(): Conductor {
  const tools = createToolRegistry();
  tools.register(makeEchoTool());
  return createConductorCore({
    adjudicator: new StubAdjudicator(),
    memory: new InMemoryMemoryProvider(),
    grounding: new EmptyGroundingProvider(),
    planner: makePlanner(),
    responder: makeResponder(),
    explainer: makeExplainer(),
    handoff: makeHandoff(),
    telemetry: new RecordingTelemetrySink(),
    session: new InMemorySessionStore(),
    tools,
    channels: [new WebChannelStub()],
    tenantResolver: makeTenantResolver(),
  });
}

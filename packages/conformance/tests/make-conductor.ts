/**
 * Test harness — assembles a Conductor wired entirely from in-memory
 * test doubles (the ones exported by `@claustrum/core/test-doubles`).
 *
 * Used by every conformance test in this package to exercise the suite
 * against a known-good baseline. Adopter conductors are exercised via
 * the public `runConformance()` API.
 */

import { buildEnvelope, type Decision, type IntentEnvelope } from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  type Capsule,
  type CapabilityId,
  type ChannelDriver,
  type Conductor,
  type DraftResponse,
  type ExplainerPort,
  type HandoffPort,
  type IntentKind,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type SessionPort,
  type TenantResolver,
  type ToolDefinition,
  type ToolRegistry,
} from "@claustrum/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "@claustrum/core/test-doubles";

const SAMPLE_CAPABILITY = "demo.echo" as CapabilityId;
const SAMPLE_INTENT_KIND = "demo.echo" as IntentKind;

/**
 * A planner that proposes one envelope of kind `demo.echo` for normal
 * input, and kind `danger` (which the StubAdjudicator REFUSEs) for
 * inputs containing "danger".
 */
function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const text = state.perception.text;
      const kind: string = text.includes("danger") ? "danger" : "demo.echo";
      const envelope = buildEnvelope({
        kind,
        payload: { text },
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
        createdAt: "2026-05-18T00:00:00.000Z",
      }) as IntentEnvelope;
      return {
        envelopes: [envelope],
        rationale: "test-double planner",
        capabilities: [String(envelope.kind)],
      };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      if (input.decision.kind === "REFUSE") {
        return { text: input.decision.refusal.userFacing };
      }
      return { text: `Echo: ${input.cognition.perception.text}` };
    },
  };
}

function makeExplainer(): ExplainerPort {
  return {
    render(refusal): string {
      return refusal.userFacing;
    },
  };
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
    async resolve(): Promise<{
      tenant: {
        tenantId: string;
        displayName: string;
        locale: string;
        environment: "dev" | "staging" | "prod";
      };
      state: unknown;
      policy: unknown;
    }> {
      return {
        tenant: {
          tenantId: "test-tenant",
          displayName: "Test",
          locale: "pt-BR",
          environment: "dev",
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
    capability: SAMPLE_CAPABILITY,
    description: "Echo back the user's text.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    intentKind: SAMPLE_INTENT_KIND,
    riskLevel: "low",
    async execute(input): Promise<{ echoed: string }> {
      return { echoed: input.text };
    },
  };
}

export interface TestConductorBundle {
  readonly conductor: Conductor;
  readonly telemetry: RecordingTelemetrySink;
  readonly memory: InMemoryMemoryProvider;
  readonly session: InMemorySessionStore;
  readonly adjudicator: StubAdjudicator;
  readonly tools: ToolRegistry;
  readonly channel: ChannelDriver;
}

export interface MakeTestConductorOptions {
  /**
   * Override the default tool registry (which has a single `demo.echo`
   * tool). Pass `null` for an empty registry. Used by CC-001 tests to
   * probe the "no tools registered" and "internal id leak" branches.
   */
  readonly tools?: ToolRegistry | null;
  /**
   * Override the default (decision-aware) responder. Used by CC-007 tests
   * to inject a decision-BLIND responder (one that ignores `input.decision`
   * and answers from the user text alone) and prove the check fails it.
   */
  readonly responder?: ResponderPort;
}

export function makeTestConductor(
  options: MakeTestConductorOptions = {},
): TestConductorBundle {
  const telemetry = new RecordingTelemetrySink();
  const memory = new InMemoryMemoryProvider();
  const session = new InMemorySessionStore();
  const adjudicator = new StubAdjudicator();
  const channel = new WebChannelStub();
  let tools: ToolRegistry;
  if (options.tools === null) {
    tools = createToolRegistry();
  } else if (options.tools !== undefined) {
    tools = options.tools;
  } else {
    tools = createToolRegistry();
    tools.register(makeEchoTool());
  }

  const conductor = createConductor({
    adjudicator,
    memory,
    grounding: new EmptyGroundingProvider(),
    planner: makePlanner(),
    responder: options.responder ?? makeResponder(),
    explainer: makeExplainer(),
    handoff: makeHandoff(),
    telemetry,
    session,
    tools,
    channels: [channel],
    tenantResolver: makeTenantResolver(),
  });

  void SAMPLE_CAPABILITY;
  void SAMPLE_INTENT_KIND;
  void ({} as Capsule);
  void ({} as Decision);
  void ({} as SessionPort);

  return { conductor, telemetry, memory, session, adjudicator, tools, channel };
}

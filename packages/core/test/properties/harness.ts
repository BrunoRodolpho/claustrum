/**
 * Shared property-test harness.
 *
 * Builds a Capsule wired against in-memory test-doubles + supplied
 * `PlannerPort` + `ResponderPort` + `ExplainerPort` + tool registry.
 * Property tests parameterise the planner / tools to verify invariants
 * across many random inputs.
 */

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type {
  Capsule,
  ChannelMap,
  ChannelMessage,
  ExplainerPort,
  HandoffPort,
  PlannerPort,
  ResponderPort,
  ToolDefinition,
  CapabilityId,
} from "../../src/index.js";
import { createToolRegistry } from "../../src/index.js";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "../../src/test-doubles/index.js";

export interface HarnessParts {
  readonly capsule: Capsule;
  readonly adjudicator: StubAdjudicator;
  readonly telemetry: RecordingTelemetrySink;
  readonly memory: InMemoryMemoryProvider;
  readonly session: InMemorySessionStore;
  readonly channelDriver: WebChannelStub;
  readonly tools: ReturnType<typeof createToolRegistry>;
}

export interface HarnessOptions {
  readonly planner: PlannerPort;
  readonly responder: ResponderPort;
  readonly explainer?: ExplainerPort;
  readonly handoff?: HandoffPort;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly customerId?: string;
}

const defaultExplainer: ExplainerPort = {
  render(refusal) {
    return refusal.userFacing;
  },
};

const defaultHandoff: HandoffPort = {
  async queue() {
    // no-op
  },
};

export async function buildHarness(
  options: HarnessOptions,
): Promise<HarnessParts> {
  const adjudicator = new StubAdjudicator();
  const telemetry = new RecordingTelemetrySink();
  const memory = new InMemoryMemoryProvider();
  const grounding = new EmptyGroundingProvider();
  const session = new InMemorySessionStore();
  const channelDriver = new WebChannelStub();
  const tools = createToolRegistry();

  for (const tool of options.tools ?? []) {
    tools.register(tool);
  }

  const customerId = options.customerId ?? "cust-test";
  await session.load(customerId, "web");

  const channels: ChannelMap = { web: channelDriver };

  const capsule: Capsule = {
    tenant: {
      tenantId: "test-tenant",
      displayName: "Test",
      locale: "pt-BR",
      environment: "dev",
    },
    customerId,
    actor: {
      principal: "user",
      sessionId: session.current().id,
      customerId,
      role: "customer",
    },
    conversationId: "conv-test",
    turnId: "turn-test",
    traceId: "trace-test",
    channel: "web",
    locale: "pt-BR",
    environment: "dev",
    memory,
    grounding,
    planner: options.planner,
    tools,
    channels,
    responder: options.responder,
    adjudicator,
    explainer: options.explainer ?? defaultExplainer,
    handoff: options.handoff ?? defaultHandoff,
    telemetry,
    session,
    state: undefined,
    policy: undefined,
    adjudicate(envelope) {
      return adjudicator.adjudicate(envelope, undefined, undefined);
    },
    adjudicatePlan(envelopes) {
      return adjudicator.adjudicatePlan(envelopes, undefined, undefined);
    },
  };

  return {
    capsule,
    adjudicator,
    telemetry,
    memory,
    session,
    channelDriver,
    tools,
  };
}

export function buildInbound(text: string): ChannelMessage {
  return {
    channel: "web",
    customerId: "cust-test",
    conversationId: "conv-test",
    text,
    receivedAt: new Date().toISOString(),
  };
}

export function buildTestEnvelope(input: {
  readonly kind: string;
  readonly payload?: unknown;
  readonly principal?: "llm" | "user" | "system";
  readonly nonce?: string;
}): IntentEnvelope {
  return buildEnvelope({
    kind: input.kind,
    payload: input.payload ?? { value: 1 },
    actor: {
      principal: input.principal ?? "llm",
      sessionId: "session-prop",
    },
    taint: "TRUSTED",
    nonce: input.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`,
  });
}

export type ToolDefinitionLite = ToolDefinition;

export function makeTool(input: {
  readonly id: string;
  readonly capability: string;
  readonly intentKind: string;
  readonly execute: (input: unknown, ctx: unknown) => Promise<unknown>;
}): ToolDefinitionLite {
  return {
    id: input.id,
    capability: input.capability as CapabilityId,
    description: input.id,
    inputSchema: {},
    outputSchema: {},
    intentKind: input.intentKind as ToolDefinitionLite["intentKind"],
    riskLevel: "low",
    execute: input.execute,
  };
}

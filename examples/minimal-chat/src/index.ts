/* eslint-disable no-console -- Example app writes user-facing stdout. */
/**
 * minimal-chat — claustrum end-to-end reference application.
 *
 * Demonstrates the cognitive loop in ~150 lines:
 *   1. Construct a Conductor with Anthropic + in-memory stubs.
 *   2. Register a small ToolPack with two capabilities.
 *   3. Open a Capsule for one customer turn.
 *   4. Run `handleTurn`, print decision + audit hash + response.
 *
 * No ibatexas dependency. No external services beyond the Anthropic
 * Messages API (gated on `ANTHROPIC_API_KEY`; absent, the example falls
 * back to the in-memory model double so the build/test path stays
 * hermetic).
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { AnthropicProvider, type AnthropicClientLike } from "@claustrum/anthropic";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type CapabilityId,
  type Conductor,
  type DraftResponse,
  type ExplainerPort,
  type HandoffPort,
  type IntentKind,
  type ModelProvider,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type TenantResolver,
  type ToolDefinition,
} from "@claustrum/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemoryModelProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "@claustrum/core/test-doubles";
import { z } from "zod";

// ── Capabilities ────────────────────────────────────────────────────────────

const WEATHER_LOOKUP = "weather.lookup" as CapabilityId;
const CALENDAR_BOOK = "calendar.book" as CapabilityId;
const WEATHER_INTENT = "weather.lookup" as IntentKind;
const CALENDAR_INTENT = "calendar.book" as IntentKind;

const WeatherInputSchema = z.object({ city: z.string().min(1) });
const CalendarInputSchema = z.object({
  attendee: z.string().min(1),
  iso: z.string(),
});

// ── Ports ───────────────────────────────────────────────────────────────────

function makeModelProvider(): ModelProvider {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey !== undefined && apiKey.length > 0) {
    // The SDK's stronger types are structurally compatible with the
    // adapter's `AnthropicClientLike` surface; cast through `unknown`
    // because the SDK narrows `stream: false` while the adapter accepts
    // the broader `boolean | undefined`.
    const client = new Anthropic({ apiKey }) as unknown as AnthropicClientLike;
    return new AnthropicProvider({ client });
  }
  // Hermetic fallback so `pnpm build` works without a key.
  return new InMemoryModelProvider();
}

/**
 * A toy planner that maps inbound text to one of the registered
 * capabilities. Real adopters drive this with an LLM via
 * `ModelProvider`; the simplified branching here keeps the example
 * self-contained.
 */
function makePlanner(): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const text = state.perception.text.toLowerCase();
      let kind: string;
      let payload: unknown;
      if (text.includes("weather")) {
        kind = "weather.lookup";
        payload = { city: text.split(/\s+/).pop() ?? "Sao Paulo" };
      } else if (text.includes("book") || text.includes("schedule")) {
        kind = "calendar.book";
        payload = { attendee: "demo-user", iso: "2026-05-20T15:00:00Z" };
      } else if (text.includes("danger")) {
        kind = "danger"; // StubAdjudicator REFUSEs this
        payload = {};
      } else {
        kind = "weather.lookup";
        payload = { city: "Sao Paulo" };
      }
      const envelope = buildEnvelope({
        kind,
        payload,
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
      }) as IntentEnvelope;
      return {
        envelopes: [envelope],
        capabilities: [String(envelope.kind)],
      };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      switch (input.decision.kind) {
        case "EXECUTE":
          return { text: `Decision EXECUTE. Plan ran ${input.plan.envelopes.length} envelope(s).` };
        case "REFUSE":
          return { text: input.decision.refusal.userFacing };
        case "REQUEST_CONFIRMATION":
          return { text: input.decision.prompt };
        case "DEFER":
          return { text: `Deferred (signal=${input.decision.signal}).` };
        case "ESCALATE":
          return { text: `Escalating to ${input.decision.to}: ${input.decision.reason}` };
        case "REWRITE":
          return { text: "Rewritten and executed." };
      }
    },
  };
}

function makeExplainer(): ExplainerPort {
  return { render: (refusal) => refusal.userFacing };
}

function makeHandoff(): HandoffPort {
  return {
    async queue(): Promise<void> {
      /* no-op for the demo */
    },
  };
}

function makeTenantResolver(): TenantResolver {
  return {
    async resolve() {
      return {
        tenant: {
          tenantId: "minimal-chat",
          displayName: "Minimal Chat",
          locale: "en-US",
          environment: "dev" as const,
        },
        state: {},
        policy: {},
      };
    },
  };
}

function makeWeatherTool(): ToolDefinition<{ city: string }, { degrees: number; city: string }> {
  return {
    id: "weather.lookup.v1",
    capability: WEATHER_LOOKUP,
    description: "Look up the current temperature for a city.",
    inputSchema: WeatherInputSchema,
    outputSchema: z.object({ degrees: z.number(), city: z.string() }),
    intentKind: WEATHER_INTENT,
    riskLevel: "low",
    async execute(input): Promise<{ degrees: number; city: string }> {
      return { degrees: 22, city: input.city };
    },
  };
}

function makeCalendarTool(): ToolDefinition<
  { attendee: string; iso: string },
  { booked: boolean; id: string }
> {
  return {
    id: "calendar.book.v1",
    capability: CALENDAR_BOOK,
    description: "Schedule a meeting with an attendee at the given ISO time.",
    inputSchema: CalendarInputSchema,
    outputSchema: z.object({ booked: z.boolean(), id: z.string() }),
    intentKind: CALENDAR_INTENT,
    riskLevel: "medium",
    async execute(input): Promise<{ booked: boolean; id: string }> {
      return { booked: true, id: `meet-${input.attendee}-${input.iso}` };
    },
  };
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

export function createMinimalChatConductor(): Conductor {
  const tools = createToolRegistry();
  tools.register(makeWeatherTool());
  tools.register(makeCalendarTool());

  // Touch the model provider so it's instantiated lazily — real adopters
  // would wire this into the planner/responder. The minimal example uses
  // a rule-based planner to keep the demo deterministic.
  const _model = makeModelProvider();
  void _model;

  return createConductor({
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

/** Alias for the CLI loader (`claustrum replay --conductor ...`). */
export { createMinimalChatConductor as createConductor };

async function main(): Promise<void> {
  const conductor = createMinimalChatConductor();
  const inbound = {
    channel: "web" as const,
    customerId: "demo-customer",
    conversationId: "demo-conv",
    text: "what is the weather in Lisbon today?",
    receivedAt: new Date().toISOString(),
  };
  const capsule = await conductor.openCapsule({
    channel: inbound.channel,
    customerId: inbound.customerId,
    inbound,
  });
  try {
    const result = await handleTurn(capsule, inbound);
    console.warn("decision.kind :", result.decision.kind);
    console.warn(
      "envelope hash :",
      result.plan.envelopes[0]?.intentHash ?? "(no envelope)",
    );
    console.warn(
      "audit hash    :",
      result.audit ?? "(stub adjudicator does not emit AuditRecord)",
    );
    console.warn("response      :", result.response.text);
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

const isMain =
  import.meta.url ===
  ("file://" + (process.argv[1] ?? "").replace(/\\/g, "/"));
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

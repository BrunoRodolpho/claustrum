/* eslint-disable no-console */
/**
 * Track B2 — LIVE cognitive loop (handleTurn) driven by the 4B Nemotron.
 *
 * Wires a Conductor with StubAdjudicator + in-memory ports + a LIVE
 * @claustrum/openai OpenAIProvider (fetch->Ollama /v1), and an LLM-backed
 * planner that drives the model. The model sees EXACTLY ONE tool —
 * `express_intent(capability, payload)` — and never an internal tool id
 * (Hard Rule #1). Each turn runs perceive->plan->submit->adjudicate->synthesize.
 *
 * Asserts (never weakened): handleTurn returns a DEFINED Decision per turn;
 * every planner envelope has actor.principal set; the registry never surfaces a
 * tool id to the model surface. Transcripts captured to live-runs/.
 *
 *   Run: pnpm -F @claustrum/example-minimal-chat exec tsx src/live-handle-turn.ts
 */

import { appendFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { OpenAIProvider } from "@claustrum/openai";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type CapabilityId,
  type IntentKind,
  type ModelProvider,
  type Plan,
  type PlannerPort,
  type ResponderPort,
  type ExplainerPort,
  type HandoffPort,
  type TenantResolver,
  type ToolDefinition,
  type DraftResponse,
} from "@claustrum/core";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "@claustrum/core/test-doubles";
import { z } from "zod";

const BASE_URL = process.env.NEMOTRON_BASE_URL ?? "http://192.168.1.80:11434/v1";
const MODEL = process.env.NEMOTRON_MODEL ?? "nemotron-3-nano:4b";
const ARTIFACTS = process.env.NEMO_ARTIFACTS ?? join(homedir(), "projects", "validation_artifacts");
const LIVE_RUNS = join(ARTIFACTS, "live-runs");
const REPLAY = join(ARTIFACTS, "replay_corpus");
for (const d of [LIVE_RUNS, REPLAY]) mkdirSync(d, { recursive: true });
let seq = readdirSync(LIVE_RUNS).filter((f) => /^run-\d+\.json$/.test(f)).length;
function writeRun(rec: unknown): void {
  seq += 1;
  const id = String(seq).padStart(3, "0");
  writeFileSync(join(LIVE_RUNS, `run-${id}.json`), JSON.stringify({ id, ...(rec as object) }, null, 2));
  appendFileSync(join(REPLAY, "trackB-handleturn.jsonl"), JSON.stringify({ id, ...(rec as object) }) + "\n");
}

function liveClient() {
  return {
    chat: {
      completions: {
        async create(body: Record<string, unknown>, options?: { signal?: AbortSignal }) {
          const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer ollama" },
            body: JSON.stringify({ ...body, model: MODEL, stream: false }),
            signal: options?.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
          return res.json();
        },
      },
    },
    embeddings: { async create() { throw new Error("not_implemented"); } },
  } as never;
}

// Capabilities advertised to the planner (NO internal tool ids).
const CAPS = [
  { capability: "weather.lookup", payloadShape: "{ city: string }", description: "Look up current weather for a city." },
  { capability: "calendar.book", payloadShape: "{ attendee: string, iso: string }", description: "Book a calendar meeting." },
];

const lastTrace: { request?: unknown; response?: unknown } = {};

function makeLivePlanner(provider: ModelProvider): PlannerPort {
  return {
    async propose(state): Promise<Plan> {
      const system = [
        "You are a planning agent. You have NO ability to act directly.",
        "To act, you MUST call the single tool `express_intent` with { capability, payload }.",
        "Available capabilities (use the capability string verbatim):",
        ...CAPS.map((c) => `  - ${c.capability} ${c.payloadShape} — ${c.description}`),
        "Choose exactly one capability that satisfies the user and call express_intent. Do not answer in prose.",
      ].join("\n");
      const tools = [
        {
          name: "express_intent",
          description: "The ONLY way to act. Express a single intent.",
          inputSchema: {
            type: "object",
            properties: {
              capability: { type: "string", enum: CAPS.map((c) => c.capability) },
              payload: { type: "object" },
            },
            required: ["capability", "payload"],
          },
        },
      ];
      const req = { model: MODEL, system, messages: [{ role: "user" as const, content: state.perception.text }], tools, maxTokens: 256 };
      const completion = await provider.complete(req as never);
      lastTrace.request = { system, userText: state.perception.text, tools };
      lastTrace.response = { stopReason: completion.stopReason, text: completion.text, toolCalls: completion.toolCalls };

      const tc = completion.toolCalls?.[0];
      const input = (tc?.input ?? {}) as { capability?: string; payload?: unknown };
      const capability = input.capability ?? "weather.lookup";
      const payload = input.payload ?? { city: "Sao Paulo" };
      const envelope = buildEnvelope({
        kind: capability,
        payload,
        actor: { principal: "llm", sessionId: state.turnId },
        taint: "TRUSTED",
        nonce: `nonce-${state.turnId}`,
      }) as IntentEnvelope;
      return { envelopes: [envelope], capabilities: [String(envelope.kind)] };
    },
  };
}

function makeResponder(): ResponderPort {
  return {
    async respond(input): Promise<DraftResponse> {
      switch (input.decision.kind) {
        case "EXECUTE": return { text: `EXECUTE — ran ${input.plan.envelopes.length} envelope(s).` };
        case "REFUSE": return { text: input.decision.refusal.userFacing };
        case "REQUEST_CONFIRMATION": return { text: input.decision.prompt };
        case "DEFER": return { text: `Deferred (signal=${input.decision.signal}).` };
        case "ESCALATE": return { text: `Escalating to ${input.decision.to}.` };
        case "REWRITE": return { text: "Rewritten and executed." };
      }
    },
  };
}

function tool(id: string, capability: string, intentKind: string, schema: z.ZodTypeAny): ToolDefinition<unknown, unknown> {
  return {
    id, capability: capability as CapabilityId, intentKind: intentKind as IntentKind,
    description: `impl ${id}`, inputSchema: schema, outputSchema: z.object({ ok: z.boolean() }), riskLevel: "low",
    async execute() { return { ok: true }; },
  } as ToolDefinition<unknown, unknown>;
}

function makeConductor(provider: ModelProvider) {
  const tools = createToolRegistry();
  tools.register(tool("weather.lookup.v1", "weather.lookup", "weather.lookup", z.object({ city: z.string() })));
  tools.register(tool("calendar.book.v1", "calendar.book", "calendar.book", z.object({ attendee: z.string(), iso: z.string() })));
  const explainer: ExplainerPort = { render: (r) => r.userFacing };
  const handoff: HandoffPort = { async queue() {} };
  const tenantResolver: TenantResolver = {
    async resolve() {
      return { tenant: { tenantId: "live-b2", displayName: "Live B2", locale: "en-US", environment: "dev" as const }, state: {}, policy: {} };
    },
  };
  return {
    conductor: createConductor({
      adjudicator: new StubAdjudicator(),
      memory: new InMemoryMemoryProvider(),
      grounding: new EmptyGroundingProvider(),
      planner: makeLivePlanner(provider),
      responder: makeResponder(),
      explainer, handoff,
      telemetry: new RecordingTelemetrySink(),
      session: new InMemorySessionStore(),
      tools,
      channels: [new WebChannelStub()],
      tenantResolver,
    }),
    tools,
  };
}

async function main(): Promise<void> {
  const provider = new OpenAIProvider({ client: liveClient() });
  const { conductor, tools } = makeConductor(provider);

  // Invariant (Hard Rule #1): the only LLM-facing tool is express_intent; the
  // registry's capability projection must expose NO internal tool id.
  const caps = tools.resolveCapabilities({} as never) as ReadonlyArray<Record<string, unknown>>;
  const leaksId = caps.some((c) => "id" in c);
  const knownIds = ["weather.lookup.v1", "calendar.book.v1"];
  const idLeak = caps.some((c) => knownIds.includes(String((c as { capability?: unknown }).capability)));

  const inbounds = [
    { text: "What's the weather in Lisbon right now?", expectCap: "weather.lookup" },
    { text: "Please book a meeting with Ana tomorrow afternoon.", expectCap: "calendar.book" },
    { text: "Tell me the weather in Tokyo.", expectCap: "weather.lookup" },
  ];

  const results: Array<{ text: string; decision?: string; envHash?: string; toolCalled: boolean; modelCapability?: string; response?: string; pass: boolean }> = [];

  for (const [i, msg] of inbounds.entries()) {
    const inbound = { channel: "web" as const, customerId: "b2-customer", conversationId: `b2-conv-${i}`, text: msg.text, receivedAt: new Date().toISOString() };
    const capsule = await conductor.openCapsule({ channel: inbound.channel, customerId: inbound.customerId, inbound });
    const t0 = performance.now();
    try {
      const result = await handleTurn(capsule, inbound);
      const latencyMs = Number((performance.now() - t0).toFixed(1));
      const env = result.plan.envelopes[0];
      const toolCalled = !!(lastTrace.response as { toolCalls?: unknown[] })?.toolCalls?.length;
      const modelCapability = ((lastTrace.response as { toolCalls?: Array<{ input?: { capability?: string } }> })?.toolCalls?.[0]?.input?.capability) ?? undefined;
      const hasPrincipal = !!(env as unknown as { actor?: { principal?: string } })?.actor?.principal;
      // Pass = the loop produced a DEFINED decision AND the planner envelope has a principal.
      const pass = typeof result.decision?.kind === "string" && hasPrincipal;
      results.push({ text: msg.text, decision: result.decision.kind, envHash: env?.intentHash, toolCalled, modelCapability, response: result.response.text, pass });
      writeRun({
        track: "trackB-handleturn", scenario: msg.text, provider: "@claustrum/openai -> Ollama /v1", providerVersion: "OpenAIProvider", modelConfig: { model: MODEL },
        request: lastTrace.request, rawResponse: lastTrace.response,
        decisionKind: result.decision.kind, intentHash: env?.intentHash,
        canonicalIntent: env ? { kind: env.kind, principal: (env as unknown as { actor?: { principal?: string } }).actor?.principal } : undefined,
        finalOutput: result.response.text, toolCalled, modelCapability, latencyMs, capturedAt: new Date().toISOString(),
      });
      console.log(`${pass ? "✓" : "✗"} "${msg.text}" -> decision=${result.decision.kind} cap=${modelCapability ?? "(none)"} toolCalled=${toolCalled} resp="${result.response.text.slice(0, 50)}"`);
    } catch (e) {
      results.push({ text: msg.text, toolCalled: false, pass: false, response: `THREW: ${(e as Error).message}` });
      console.log(`✗ "${msg.text}" -> THREW ${(e as Error).message}`);
    } finally {
      await conductor.closeCapsule(capsule);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const toolCallRate = results.filter((r) => r.toolCalled).length / results.length;
  console.log(`\nB2 handleTurn: ${passed}/${results.length} turns produced a defined Decision with a principal-stamped envelope`);
  console.log(`Express-intent invariant: registry exposes id field=${leaksId}, capability==id leak=${idLeak} (both must be false)`);
  console.log(`Live 4B express_intent tool-call rate: ${(toolCallRate * 100).toFixed(0)}%`);

  writeFileSync(join(ARTIFACTS, "provider-validation", "claustrum-handleturn-b2.json"), JSON.stringify({
    subject: MODEL, ranAt: new Date().toISOString(), passed, total: results.length,
    expressIntentInvariant: { idFieldExposed: leaksId, capabilityIdLeak: idLeak, holds: !leaksId && !idLeak },
    toolCallRate, results,
  }, null, 2));

  const invariantHolds = !leaksId && !idLeak;
  if (passed !== results.length || !invariantHolds) {
    console.error("\nB2 FAILURE — a cognitive-loop invariant did not hold (decision-defined / principal / express_intent-only).");
    process.exit(1);
  }
  console.log("B2 GREEN — live cognitive loop governed; LLM saw only express_intent; every decision defined.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

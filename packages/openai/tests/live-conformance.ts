/**
 * Track B1 + Phase 0 (claustrum-openai): LIVE ModelProvider conformance.
 *
 * Runs the FROZEN @claustrum/core ModelProvider contract against the REAL
 * @claustrum/openai OpenAIProvider wired to a fetch->Ollama /v1 client (no
 * `openai` npm dependency), plus extra live protocol assertions the
 * non-streaming adjudicate adapter could not cover: STREAMING tool-call
 * reassembly by index, stop-reason normalization, and tool_call id / multi-tool.
 *
 * The LLM is an untrusted subject: we assert the PROVIDER CONTRACT holds, never
 * that the 4B produces specific content.
 *
 *   Run: pnpm -F @claustrum/openai exec tsx tests/live-conformance.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider } from "@claustrum/openai";
import { runModelProviderContract } from "@claustrum/core/test-doubles";
import type { CompletionRequest } from "@claustrum/core";

const BASE_URL = process.env.NEMOTRON_BASE_URL ?? "http://192.168.1.80:11434/v1";
const MODEL = process.env.NEMOTRON_MODEL ?? "nemotron-3-nano:4b";
const ARTIFACTS = process.env.NEMO_ARTIFACTS ?? join(homedir(), "projects", "validation_artifacts");
const PV_DIR = join(ARTIFACTS, "provider-validation");
mkdirSync(PV_DIR, { recursive: true });

// ── fetch -> Ollama /v1 client implementing OpenAIClientLike ────────────────
function makeLiveClient() {
  async function create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    const isStream = body.stream === true;
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ollama" },
      body: JSON.stringify({ ...body, model: MODEL }),
      signal: options?.signal,
    });
    if (!res.ok) throw new Error(`Nemotron HTTP ${res.status}: ${await res.text()}`);
    if (!isStream) return res.json();
    // SSE -> async iterable of OpenAI chunks
    const reader = res.body;
    async function* gen(): AsyncGenerator<unknown> {
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const part of reader as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(part, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") return;
            try {
              yield JSON.parse(data);
            } catch {
              /* skip keep-alive/partial */
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // clean cancel
        throw err;
      }
    }
    return gen();
  }
  return {
    chat: { completions: { create } },
    embeddings: {
      async create(body: { model: string; input: string | ReadonlyArray<string> }, options?: { signal?: AbortSignal }) {
        const res = await fetch(`${BASE_URL}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer ollama" },
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
        return res.json();
      },
    },
  } as never;
}

// ── minimal ContractTestSurface that QUEUES async it-bodies ─────────────────
interface Queued { name: string; body: () => void | Promise<void> }
const queue: Queued[] = [];
const surface = {
  describe(_name: string, body: () => void) { body(); },
  it(name: string, body: () => void | Promise<void>) { queue.push({ name, body }); },
  expect<T>(actual: T) {
    return {
      toBeDefined() { if (actual === undefined || actual === null) throw new Error(`expected defined, got ${String(actual)}`); },
      toBe(expected: T) { if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`); },
      toBeGreaterThan(expected: number) { if (!((actual as unknown as number) > expected)) throw new Error(`expected > ${expected}, got ${String(actual)}`); },
      toContain(expected: unknown) {
        const ok = Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(String(expected));
        if (!ok) throw new Error(`expected ${String(actual)} to contain ${String(expected)}`);
      },
    };
  },
};

const results: Array<{ id: string; group: string; pass: boolean; error?: string; detail?: unknown }> = [];

async function runQueued(group: string) {
  for (const q of queue.splice(0, queue.length)) {
    try {
      await q.body();
      results.push({ id: q.name, group, pass: true });
      console.log(`✓ [${group}] ${q.name}`);
    } catch (e) {
      results.push({ id: q.name, group, pass: false, error: String((e as Error).message) });
      console.log(`✗ [${group}] ${q.name} — ${(e as Error).message}`);
    }
  }
}

const REFUND_TOOL = {
  name: "express_intent",
  description: "Express an intent to refund a charge. capability=pix.refund.",
  inputSchema: { type: "object", properties: { chargeId: { type: "string" }, amountCents: { type: "integer" } }, required: ["chargeId", "amountCents"] },
} as const;

async function main(): Promise<void> {
  const client = makeLiveClient();
  const provider = new OpenAIProvider({ client });

  // ── Frozen ModelProvider contract (skipEmbed: chat-only 4B has no embedding capability) ──
  runModelProviderContract({ factory: () => new OpenAIProvider({ client }), surface, skipEmbed: true });
  await runQueued("contract");

  // ── Extra live protocol assertions ──
  async function record(id: string, fn: () => Promise<{ pass: boolean; detail?: unknown }>) {
    try {
      const { pass, detail } = await fn();
      results.push({ id, group: "protocol-live", pass, detail });
      console.log(`${pass ? "✓" : "✗"} [protocol-live] ${id}`);
    } catch (e) {
      results.push({ id, group: "protocol-live", pass: false, error: String((e as Error).message) });
      console.log(`✗ [protocol-live] ${id} — ${(e as Error).message}`);
    }
  }

  // PL1: complete() stop-reason normalization for a plain turn -> end_turn
  await record("PL1-stopreason-end_turn", async () => {
    const r = await provider.complete({ model: MODEL, messages: [{ role: "user", content: "Say hi in one word." }], maxTokens: 32 } as CompletionRequest);
    return { pass: r.stopReason === "end_turn" || r.stopReason === "max_tokens", detail: { stopReason: r.stopReason, text: r.text.slice(0, 60) } };
  });

  // PL2: complete() with a tool -> tool_use stop-reason + structured toolCalls (id+name+input parsed)
  await record("PL2-complete-toolcall", async () => {
    const r = await provider.complete({
      model: MODEL,
      system: "When asked to refund, call express_intent with the charge id and amount in cents. Do not answer in prose.",
      messages: [{ role: "user", content: "Refund charge cha-77 for R$ 12,00." }],
      tools: [REFUND_TOOL],
      maxTokens: 256,
    } as CompletionRequest);
    const tc = r.toolCalls?.[0];
    const pass = r.stopReason === "tool_use" && !!tc && typeof tc.id === "string" && tc.name === "express_intent" && typeof tc.input === "object";
    return { pass, detail: { stopReason: r.stopReason, toolCall: tc } };
  });

  // PL3: stream() reassembles fragmented tool_calls by index -> tool_use_start + done
  await record("PL3-stream-toolcall-reassembly", async () => {
    const stream = provider.stream({
      model: MODEL,
      system: "When asked to refund, call express_intent with the charge id and amount in cents. Do not answer in prose.",
      messages: [{ role: "user", content: "Refund charge cha-99 for R$ 5,00." }],
      tools: [REFUND_TOOL],
      maxTokens: 256,
    } as CompletionRequest);
    const seen: string[] = [];
    let toolName: string | undefined;
    let argText = "";
    for await (const c of stream) {
      seen.push(c.type);
      if (c.type === "tool_use_start") toolName = (c as { name: string }).name;
      if (c.type === "tool_input_delta") argText += (c as { delta: string }).delta;
      if (c.type === "done" || c.type === "cancelled") break;
    }
    const terminals = seen.filter((t) => t === "done" || t === "cancelled");
    const reassembled = toolName === "express_intent";
    const pass = terminals.length === 1 && seen[seen.length - 1] === terminals[0] && reassembled;
    return { pass, detail: { events: seen, toolName, argTextSample: argText.slice(0, 80) } };
  });

  // PL4: stream() mid-flight cancel is observable (aborted) and terminates cleanly
  await record("PL4-stream-cancel-midflight", async () => {
    const stream = provider.stream({ model: MODEL, messages: [{ role: "user", content: "Write a long paragraph about coffee." }], maxTokens: 512 } as CompletionRequest);
    let count = 0;
    for await (const c of stream) {
      count += 1;
      if (count >= 2) { stream.cancel(); break; }
      void c;
    }
    for await (const _c of stream) void _c;
    return { pass: stream.aborted === true, detail: { chunksBeforeCancel: count } };
  });

  const passed = results.filter((r) => r.pass).length;
  console.log(`\nclaustrum-openai provider validation: ${passed}/${results.length}`);
  writeFileSync(join(PV_DIR, "claustrum-openai.json"), JSON.stringify({
    adapter: "@claustrum/openai OpenAIProvider", subject: MODEL, baseUrl: BASE_URL, ranAt: new Date().toISOString(),
    note: "embed() skipped: nemotron-3-nano:4b has no embedding capability; ibatexas grounding uses verified fail-safe (empty retrieval -> grounding-required tools fail CLOSED).",
    passed, total: results.length, results,
  }, null, 2));
  if (passed !== results.length) { console.error("\nclaustrum-openai PROVIDER VALIDATION RED"); process.exit(1); }
  console.log("Contract + live protocol GREEN for @claustrum/openai.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

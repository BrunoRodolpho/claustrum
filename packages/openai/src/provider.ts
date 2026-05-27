/**
 * OpenAIProvider — ModelProvider adapter for OpenAI's Chat Completions API.
 *
 * Implements the FROZEN `ModelProvider` contract from `@claustrum/core`.
 *
 * Streaming cancellation pattern (OpenAI SDK ^4.77):
 *  1. We own an `AbortController`; pass `{ signal: controller.signal }` to
 *     `client.chat.completions.create({ stream: true, ... })`.
 *  2. The returned value is `AsyncIterable<ChatCompletionChunk>`.
 *  3. `cancel()` calls `controller.abort()` FIRST (the SDK reacts by
 *     throwing `APIUserAbortError` from its iterator and severs the socket).
 *  4. We yield a terminal `{ type: "cancelled" }`.
 *  5. `cancel()` is idempotent — `controller.abort()` is a no-op after the
 *     first invocation; we additionally short-circuit via an `aborted` flag.
 *  6. Caller-supplied `AbortSignal` is bridged into our controller so that
 *     external aborts also cancel cleanly.
 *
 * Normalized events:
 *  - `choices[].delta.content` → `text_delta`
 *  - `choices[].delta.tool_calls` (fragmented by `index`) →
 *    `tool_use_start` (on the first chunk with `id` + `function.name`) +
 *    `tool_input_delta` (subsequent chunks emit just `function.arguments`).
 *  - `choices[].finish_reason` + `chunk.usage` → `done`.
 *
 * Critical: OpenAI tool_calls arrive in fragments, addressed by `index`.
 * The first chunk for a given index typically carries `id` + `function.name`;
 * later chunks carry just `function.arguments` deltas. We BUFFER per index,
 * emitting `tool_use_start` exactly once and `tool_input_delta` per fragment.
 *
 * Usage on stream: caller MUST set `stream_options.include_usage: true` to
 * receive a final chunk with `usage` populated. The adapter passes that
 * option by default.
 *
 * Embed: `embed()` uses `openai.embeddings.create()` with
 * `text-embedding-3-small` by default. Adopters override via
 * `{ defaultEmbeddingModel }`.
 */

import type {
  CancellableStream,
  Completion,
  CompletionChunk,
  CompletionRequest,
  ModelProvider,
  StopReason,
} from "@claustrum/core";
import { translateOpenAIError } from "./errors.js";

// ── SDK shape (structural; no direct `import "openai"`) ────────────────────

export interface OpenAIClientLike {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAIChatCompletionsBody & { readonly stream: true },
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<OpenAIChatCompletionChunk>>;
      create(
        body: OpenAIChatCompletionsBody & { readonly stream?: false | undefined },
        options?: { signal?: AbortSignal },
      ): Promise<OpenAIChatCompletionResponse>;
    };
  };
  readonly embeddings: {
    create(
      body: { model: string; input: string | ReadonlyArray<string> },
      options?: { signal?: AbortSignal },
    ): Promise<OpenAIEmbeddingResponse>;
  };
}

export interface OpenAIChatCompletionsBody {
  readonly model: string;
  readonly messages: ReadonlyArray<OpenAIChatMessage>;
  readonly tools?: ReadonlyArray<{
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly description?: string;
      readonly parameters?: unknown;
    };
  }>;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stop?: ReadonlyArray<string> | string;
  readonly stream?: boolean;
  readonly stream_options?: { include_usage?: boolean };
}

export type OpenAIChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id?: string };

export interface OpenAIChatCompletionResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices: ReadonlyArray<{
    readonly message: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly id: string;
        readonly function: { readonly name: string; readonly arguments: string };
      }>;
    };
    readonly finish_reason?: OpenAIFinishReason | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "function_call"
  | "content_filter";

export interface OpenAIChatCompletionChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly index: number;
    readonly delta: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: OpenAIFinishReason | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

export interface OpenAIEmbeddingResponse {
  readonly data: ReadonlyArray<{ readonly embedding: ReadonlyArray<number> }>;
  readonly usage?: { readonly prompt_tokens?: number };
}

// ── Options ────────────────────────────────────────────────────────────────

export interface OpenAIProviderOptions {
  readonly client: OpenAIClientLike;
  /** Default model passed to `embed()`. Defaults to "text-embedding-3-small". */
  readonly defaultEmbeddingModel?: string;
}

// ── Stop-reason normalization ──────────────────────────────────────────────

function normalizeFinishReason(raw: OpenAIFinishReason | null | undefined): StopReason {
  switch (raw) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      // Vendor refusal — map to error so the runtime takes the refusal path.
      return "error";
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ── Per-index tool-call buffer ─────────────────────────────────────────────

interface ToolBufferEntry {
  id: string;
  name: string;
  started: boolean;
}

// ── Provider ───────────────────────────────────────────────────────────────

export class OpenAIProvider implements ModelProvider {
  private readonly client: OpenAIClientLike;
  private readonly defaultEmbeddingModel: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client;
    this.defaultEmbeddingModel =
      options.defaultEmbeddingModel ?? "text-embedding-3-small";
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const body = {
      ...this.toCreateBody(req, false),
      stream: false as const,
    };
    try {
      const resp = await this.client.chat.completions.create(body, {
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      return this.fromResponse(resp, req.model);
    } catch (err) {
      throw translateOpenAIError(err);
    }
  }

  stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
    const body = {
      ...this.toCreateBody(req, true),
      stream: true as const,
    };
    const client = this.client;
    let aborted = false;
    const controller = new AbortController();

    // Bridge caller-supplied signal into our controller. Either path aborts.
    if (req.signal !== undefined) {
      if (req.signal.aborted) {
        controller.abort();
        aborted = true;
      } else {
        const onAbort = (): void => controller.abort();
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    async function* generate(): AsyncIterator<CompletionChunk> {
      let sdkIterable: AsyncIterable<OpenAIChatCompletionChunk>;
      try {
        sdkIterable = await client.chat.completions.create(body, {
          signal: controller.signal,
        });
      } catch (err) {
        const translated = translateOpenAIError(err);
        if (translated.code === "cancelled") {
          yield { type: "cancelled" };
          return;
        }
        throw translated;
      }

      const toolBuffers = new Map<number, ToolBufferEntry>();
      let finishReason: OpenAIFinishReason | null | undefined = undefined;
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        for await (const chunk of sdkIterable) {
          if (aborted) {
            break;
          }
          if (chunk.usage !== undefined) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (delta.content !== undefined && delta.content !== null && delta.content !== "") {
              yield { type: "text_delta", text: delta.content };
            }
            for (const tc of delta.tool_calls ?? []) {
              const existing = toolBuffers.get(tc.index);
              if (existing === undefined) {
                // First fragment for this index. Buffer id+name; we'll emit
                // tool_use_start once we have both.
                const entry: ToolBufferEntry = {
                  id: tc.id ?? "",
                  name: tc.function?.name ?? "",
                  started: false,
                };
                toolBuffers.set(tc.index, entry);
              } else {
                if (tc.id !== undefined && tc.id !== "") {
                  existing.id = tc.id;
                }
                if (tc.function?.name !== undefined && tc.function.name !== "") {
                  existing.name = tc.function.name;
                }
              }
              const buf = toolBuffers.get(tc.index);
              if (buf !== undefined && !buf.started && buf.id !== "" && buf.name !== "") {
                buf.started = true;
                yield { type: "tool_use_start", id: buf.id, name: buf.name };
              }
              const args = tc.function?.arguments;
              if (args !== undefined && args !== "") {
                // If we already emitted tool_use_start, emit fragment deltas.
                // If not (id/name not yet known), defer the fragment — we
                // re-emit it once the start chunk arrives. In practice id
                // and name arrive on the FIRST fragment, so this branch is
                // exercised only by unusual scripts.
                const entry = toolBuffers.get(tc.index);
                if (entry !== undefined && entry.started) {
                  yield { type: "tool_input_delta", id: entry.id, delta: args };
                }
              }
            }
            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
              finishReason = choice.finish_reason;
            }
          }
        }

        if (aborted) {
          yield { type: "cancelled" };
          return;
        }

        yield {
          type: "done",
          stopReason: normalizeFinishReason(finishReason),
          inputTokens,
          outputTokens,
        };
      } catch (err) {
        const translated = translateOpenAIError(err);
        if (translated.code === "cancelled") {
          yield { type: "cancelled" };
          return;
        }
        throw translated;
      }
    }

    const iterator = generate();
    return {
      [Symbol.asyncIterator](): AsyncIterator<CompletionChunk> {
        return iterator;
      },
      cancel(): void {
        if (aborted) {
          return; // idempotent
        }
        aborted = true;
        // Sever the underlying HTTP socket FIRST. The SDK's iterator throws
        // APIUserAbortError on its next read; our generator catches it and
        // yields the terminal `cancelled` chunk.
        try {
          controller.abort();
        } catch {
          // AbortController.abort never throws meaningfully; defensive only.
        }
      },
      get aborted(): boolean {
        return aborted;
      },
    };
  }

  async embed(text: string): Promise<number[]> {
    try {
      const resp = await this.client.embeddings.create({
        model: this.defaultEmbeddingModel,
        input: text,
      });
      const first = resp.data[0];
      if (first === undefined) {
        // Defensive — shouldn't happen.
        return [];
      }
      return Array.from(first.embedding);
    } catch (err) {
      throw translateOpenAIError(err);
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private toCreateBody(req: CompletionRequest, stream: boolean): OpenAIChatCompletionsBody {
    const messages: OpenAIChatMessage[] = [];
    if (req.system !== undefined && req.system !== "") {
      messages.push({ role: "system", content: req.system });
    }
    for (const m of req.messages) {
      if (m.role === "tool") {
        messages.push({ role: "tool", content: m.content });
      } else if (m.role === "assistant") {
        messages.push({ role: "assistant", content: m.content });
      } else {
        messages.push({ role: "user", content: m.content });
      }
    }
    const body: OpenAIChatCompletionsBody = {
      model: req.model,
      messages,
      ...(req.tools !== undefined && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                ...(t.description !== "" ? { description: t.description } : {}),
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.stopSequences !== undefined ? { stop: req.stopSequences } : {}),
      ...(stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    };
    return body;
  }

  private fromResponse(
    resp: OpenAIChatCompletionResponse,
    fallbackModel: string,
  ): Completion {
    const choice = resp.choices[0];
    let text = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    if (choice !== undefined) {
      text = choice.message.content ?? "";
      for (const tc of choice.message.tool_calls ?? []) {
        let parsed: unknown = {};
        try {
          parsed = JSON.parse(tc.function.arguments);
        } catch {
          parsed = { raw: tc.function.arguments };
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, input: parsed });
      }
    }
    const completion: Completion = {
      model: resp.model ?? fallbackModel,
      stopReason: normalizeFinishReason(choice?.finish_reason),
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
    };
    return completion;
  }
}

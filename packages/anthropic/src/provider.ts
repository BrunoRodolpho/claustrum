/**
 * AnthropicProvider — ModelProvider adapter for Anthropic's Messages API.
 *
 * Implements the FROZEN `ModelProvider` contract from `@claustrum/core`.
 *
 * Streaming cancellation pattern (Anthropic SDK 0.82):
 *  1. `client.messages.stream({ ... }, { signal })` returns a `MessageStream`.
 *  2. We wrap it in an `async function*` that yields normalized chunks.
 *  3. `cancel()` calls `sdkStream.abort()` FIRST (severs HTTP socket),
 *     then signals our generator to return, then yields the terminal
 *     `{ type: "cancelled" }` chunk.
 *  4. `cancel()` is idempotent — second invocation is a no-op.
 *  5. Caller-supplied `AbortSignal` is also wired through to the SDK call.
 *
 * Normalized events:
 *  - `content_block_delta.text_delta` → `text_delta`
 *  - `content_block_start.tool_use` → `tool_use_start`
 *  - `content_block_delta.input_json_delta` → `tool_input_delta`
 *  - `message_stop` / terminal `finalMessage()` → `done` (with usage)
 *
 * Embed: `embed()` throws `not_implemented` unless `{ embedding: { proxy } }`
 * is supplied — Anthropic does not expose a native embedding API; adopters
 * compose with `@claustrum/openai` (or any `ModelProvider`) for vectors.
 *
 * SDK COUPLING: We accept the SDK client by injection (or via internal
 * default factory) so tests can pass a fake. The fake must expose the same
 * surface — `messages.stream(...).abort() / events / finalMessage()`,
 * `messages.create(...)` — sufficient to exercise this adapter.
 */

import type {
  CancellableStream,
  Completion,
  CompletionChunk,
  CompletionRequest,
  ModelProvider,
  StopReason,
} from "@claustrum/core";
import { CompletionError } from "@claustrum/core";
import { translateAnthropicError } from "./errors.js";

// ── SDK shape (structural; we never `import "@anthropic-ai/sdk"`) ───────────

/**
 * Minimal structural interface for the Anthropic SDK client. We accept any
 * object that conforms — the real SDK does; so does our test fake.
 */
export interface AnthropicClientLike {
  readonly messages: {
    create(
      body: AnthropicMessagesCreateBody,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessageResponse>;
    stream(
      body: AnthropicMessagesCreateBody,
      options?: { signal?: AbortSignal },
    ): AnthropicMessageStream;
  };
}

export interface AnthropicMessagesCreateBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly input_schema: unknown;
  }>;
  readonly temperature?: number;
  readonly stop_sequences?: ReadonlyArray<string>;
  readonly stream?: boolean;
}

export interface AnthropicMessageResponse {
  readonly model?: string;
  readonly stop_reason?: string | null;
  readonly content?: ReadonlyArray<AnthropicContentBlock>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

export type AnthropicStreamEvent =
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly content_block:
        | { readonly type: "text"; readonly text: string }
        | { readonly type: "tool_use"; readonly id: string; readonly name: string };
    }
  | {
      readonly type: "content_block_delta";
      readonly index: number;
      readonly delta:
        | { readonly type: "text_delta"; readonly text: string }
        | { readonly type: "input_json_delta"; readonly partial_json: string };
    }
  | { readonly type: "message_stop" }
  | { readonly type: "message_delta"; readonly delta: { readonly stop_reason?: string | null } };

export interface AnthropicMessageStream extends AsyncIterable<AnthropicStreamEvent> {
  abort(): void;
  finalMessage(): Promise<AnthropicMessageResponse>;
}

// ── SDK wrapper helper ─────────────────────────────────────────────────────

/**
 * Wraps a real `@anthropic-ai/sdk` `Anthropic` instance so it satisfies
 * `AnthropicClientLike` without any cast in user code.
 *
 * The SDK narrows the `stream` field in its overloaded `create()` signature
 * (which differs from this adapter's broader `boolean | undefined` body type),
 * causing TypeScript to reject a direct assignment.  This helper centralises
 * the one `unknown` coercion here so adopters can write:
 *
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { wrapAnthropicSdk, AnthropicProvider } from "@claustrum/anthropic";
 *
 * const client = wrapAnthropicSdk(new Anthropic({ apiKey }));
 * const provider = new AnthropicProvider({ client });
 * ```
 *
 * @param sdk - Any object whose structural shape satisfies the SDK surface
 *   we consume (real SDK or a compatible fake).
 */
export function wrapAnthropicSdk(sdk: unknown): AnthropicClientLike {
  return sdk as AnthropicClientLike;
}

// ── Options ────────────────────────────────────────────────────────────────

export interface AnthropicProviderOptions {
  /**
   * Pre-constructed SDK client. Required — we don't `require()` the SDK
   * inside this package; adopters wire it in (or pass a test fake).
   */
  readonly client: AnthropicClientLike;
  /**
   * Optional proxy for `embed()`. Anthropic has no native embedding API;
   * if you want embeddings, inject another `ModelProvider` (e.g. OpenAI).
   * Without a proxy, `embed()` throws `not_implemented`.
   */
  readonly embedding?: { readonly proxy: ModelProvider };
  /**
   * Fallback value for `max_tokens` when a CompletionRequest omits
   * `maxTokens`.  Defaults to 1024 for back-compat.  Adopters can raise
   * this (e.g. 4096) to avoid silent truncation on long responses
   * (ConfigReviewer-006).
   */
  readonly defaultMaxTokens?: number;
  /**
   * Optional structured-log hook for non-fatal provider warnings (currently the
   * `max_tokens` fallback in `toCreateBody`). Adopters wire their logger so the
   * warning lands in their structured/queryable store (e.g. ibatexas passes its
   * pino logger). Without it the provider falls back to `console.warn`
   * (back-compat). This is a caller-supplied callback, not a dependency on
   * another package — it stays within the adapter boundary.
   */
  readonly onWarn?: (message: string, fields: Record<string, unknown>) => void;
}

// ── Stop-reason normalization ──────────────────────────────────────────────

function normalizeStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "refusal":
      // Refusal is a vendor-specific stop reason — map to "error" so the
      // adjudicator/responder can react via the standard refusal path.
      return "error";
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ── Provider ───────────────────────────────────────────────────────────────

export class AnthropicProvider implements ModelProvider {
  private readonly client: AnthropicClientLike;
  private readonly embeddingProxy?: ModelProvider;
  private readonly defaultMaxTokens: number;
  private readonly onWarn?: (message: string, fields: Record<string, unknown>) => void;

  constructor(options: AnthropicProviderOptions) {
    this.client = options.client;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1024;
    this.onWarn = options.onWarn;
    if (options.embedding !== undefined) {
      this.embeddingProxy = options.embedding.proxy;
    }
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const body = this.toCreateBody(req, false);
    try {
      const resp = await this.client.messages.create(body, {
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      return this.fromResponse(resp, req.model);
    } catch (err) {
      throw translateAnthropicError(err);
    }
  }

  stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
    const body = this.toCreateBody(req, true);
    let aborted = false;
    // Construct the SDK stream eagerly so cancel() works even before the
    // caller starts iterating. The SDK is responsible for opening the HTTP
    // socket lazily on first iteration; abort() severs it either way.
    const sdkStream = this.client.messages.stream(body, {
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });

    async function* generate(): AsyncIterator<CompletionChunk> {
      // Accumulate token counts as the stream progresses. Anthropic delivers
      // authoritative usage on finalMessage(); on cancel we attempt to call
      // it (succeeds if message_stop already arrived) so partial spend is
      // visible to callers rather than silently dropped (NetworkReviewer-006).
      // Declared outside try/catch so both the abort-break path and the
      // SDK-throw-abort path (catch) can access them.
      let runningInputTokens = 0;
      let runningOutputTokens = 0;

      try {
        // Track which content_blocks are tool_use by index so input deltas
        // can be routed to the right toolUseId.
        const toolUseByIndex = new Map<number, string>();

        for await (const event of sdkStream) {
          if (aborted) {
            break;
          }
          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                toolUseByIndex.set(event.index, block.id);
                yield {
                  type: "tool_use_start",
                  id: block.id,
                  name: block.name,
                };
              }
              break;
            }
            case "content_block_delta": {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                yield { type: "text_delta", text: delta.text };
              } else if (delta.type === "input_json_delta") {
                const id = toolUseByIndex.get(event.index);
                if (id !== undefined) {
                  yield {
                    type: "tool_input_delta",
                    id,
                    delta: delta.partial_json,
                  };
                }
              }
              break;
            }
            case "message_stop":
            case "message_delta":
            default:
              // We rely on finalMessage() for the terminal `done` event so
              // the usage figures are populated correctly.
              break;
          }
        }

        if (aborted) {
          // Attempt to retrieve usage from finalMessage() — the SDK may have
          // already received the full response metadata even if we aborted
          // mid-content-stream.  On genuine mid-stream abort the call throws;
          // we catch and carry whatever running counts we have so callers see
          // partial spend rather than nothing (NetworkReviewer-006).
          try {
            const partialMsg = await sdkStream.finalMessage();
            runningInputTokens = partialMsg.usage?.input_tokens ?? runningInputTokens;
            runningOutputTokens = partialMsg.usage?.output_tokens ?? runningOutputTokens;
          } catch {
            // Abort before message_stop — usage unavailable; carry zeros.
          }
          yield {
            type: "cancelled",
            inputTokens: runningInputTokens,
            outputTokens: runningOutputTokens,
          };
          return;
        }

        const finalMsg = await sdkStream.finalMessage();
        yield {
          type: "done",
          stopReason: normalizeStopReason(finalMsg.stop_reason),
          inputTokens: finalMsg.usage?.input_tokens ?? 0,
          outputTokens: finalMsg.usage?.output_tokens ?? 0,
        };
      } catch (err) {
        const translated = translateAnthropicError(err);
        if (translated.code === "cancelled") {
          // SDK threw an abort error mid-stream (typical path: the iterator
          // throws APIUserAbortError on the next read after sdkStream.abort()).
          // Attempt to retrieve usage from finalMessage() — it may succeed if
          // the SDK received message_stop before the socket was severed.
          // On failure carry whatever running counts we have (NetworkReviewer-006).
          try {
            const partialMsg = await sdkStream.finalMessage();
            runningInputTokens = partialMsg.usage?.input_tokens ?? runningInputTokens;
            runningOutputTokens = partialMsg.usage?.output_tokens ?? runningOutputTokens;
          } catch {
            // Abort before message_stop — usage unavailable; carry zeros.
          }
          yield {
            type: "cancelled",
            inputTokens: runningInputTokens,
            outputTokens: runningOutputTokens,
          };
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
        // Sever the underlying HTTP socket FIRST. This causes the SDK's
        // iterator to throw an APIUserAbortError on its next read; our
        // generator catches it and yields the terminal `cancelled` chunk.
        try {
          sdkStream.abort();
        } catch {
          // SDK abort never throws meaningfully; swallow defensively.
        }
      },
      get aborted(): boolean {
        return aborted;
      },
    };
  }

  async embed(text: string): Promise<number[]> {
    if (this.embeddingProxy === undefined) {
      throw new CompletionError(
        "not_implemented",
        "Anthropic does not expose a native embedding API. " +
          "Construct AnthropicProvider with { embedding: { proxy } } to delegate.",
      );
    }
    return this.embeddingProxy.embed(text);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private toCreateBody(
    req: CompletionRequest,
    stream: boolean,
  ): AnthropicMessagesCreateBody {
    // Anthropic distinguishes the system prompt at the top level and only
    // allows user/assistant roles in messages. We pass the caller's tool
    // role as a user message (vendor-shaping is the caller's concern; we
    // make a single mechanical translation here).
    const messages = req.messages.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    if (req.maxTokens === undefined) {
      // Surface the fallback at warn-level so operators can raise
      // defaultMaxTokens if needed (ConfigReviewer-006 — silent 1024 truncation).
      // Through the injected onWarn hook it reaches the adopter's structured log
      // store (component:"claustrum:anthropic"); without one it falls back to
      // console.warn (back-compat).
      const message =
        `max_tokens not set on request for model ${req.model}; ` +
        `using defaultMaxTokens=${this.defaultMaxTokens}. ` +
        `Raise AnthropicProviderOptions.defaultMaxTokens to avoid silent truncation.`;
      if (this.onWarn) {
        this.onWarn(message, {
          component: "claustrum:anthropic",
          event: "max_tokens_fallback",
          model: req.model,
          defaultMaxTokens: this.defaultMaxTokens,
        });
      } else {
        console.warn(`[AnthropicProvider] ${message}`);
      }
    }
    const body: AnthropicMessagesCreateBody = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages,
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.tools !== undefined
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              ...(t.description !== "" ? { description: t.description } : {}),
              input_schema: t.inputSchema,
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stopSequences !== undefined
        ? { stop_sequences: req.stopSequences }
        : {}),
      ...(stream ? { stream: true } : {}),
    };
    return body;
  }

  private fromResponse(
    resp: AnthropicMessageResponse,
    fallbackModel: string,
  ): Completion {
    let text = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    for (const block of resp.content ?? []) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    const completion: Completion = {
      model: resp.model ?? fallbackModel,
      stopReason: normalizeStopReason(resp.stop_reason),
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
    };
    return completion;
  }
}

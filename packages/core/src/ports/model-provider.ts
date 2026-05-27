/**
 * ModelProvider — LLM completion + streaming + embedding port.
 *
 * Adapters (@claustrum/anthropic, @claustrum/openai, etc.) implement this
 * port. The cognitive loop calls `complete`/`stream` during the SYNTHESIZE
 * phase; the planner may also call into the LLM via the same port.
 *
 * Streaming MUST be cancellable: the runtime may abort mid-stream when
 * `adjudicateOutput()` returns REFUSE on a chunk that just emitted, when
 * a user reply arrives, or when a session deadline elapses. The contract
 * is `CancellableStream<T>` — an async iterable plus an idempotent
 * `cancel()` and an observable `aborted` flag.
 */

export interface CompletionRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "tool";
    readonly content: string;
  }>;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: ReadonlyArray<string>;
  /**
   * Caller-supplied AbortSignal. Independent of CancellableStream.cancel —
   * either path aborts the underlying SDK call; both are idempotent.
   */
  readonly signal?: AbortSignal;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "cancelled"
  | "error";

export interface Completion {
  readonly model: string;
  readonly stopReason: StopReason;
  readonly text: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Streaming chunk discriminated union.
 *
 * Vendor SDKs disagree on chunk shapes — Anthropic emits typed events
 * (`content_block_start`, `content_block_delta`, `message_stop`),
 * OpenAI emits flat deltas with tool-arg fragments addressed by index.
 * Adapters normalize to this union.
 */
export type CompletionChunk =
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "tool_use_start";
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: "tool_input_delta";
      readonly id: string;
      readonly delta: string;
    }
  | {
      readonly type: "done";
      readonly stopReason: StopReason;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: "cancelled" };

/**
 * Cancellable async iterable. Yielded by `ModelProvider.stream()`.
 *
 * Semantics:
 *  - `Symbol.asyncIterator` — standard for-await consumption.
 *  - `cancel()` — idempotent. Aborts SDK call, then closes generator.
 *    Final yielded chunk MUST be `{ type: "cancelled" }`.
 *  - `aborted` — observable post-cancel flag. Becomes true after the
 *    first `cancel()` call OR after the SDK's underlying signal fires.
 */
export interface CancellableStream<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
  cancel(): void;
  readonly aborted: boolean;
}

export interface ModelProvider {
  /** Non-streaming completion. Returns a single fully-formed Completion. */
  complete(req: CompletionRequest): Promise<Completion>;

  /**
   * Streaming completion. Returns a cancellable async iterable.
   * Adapters MUST emit a terminal `done` or `cancelled` chunk.
   */
  stream(req: CompletionRequest): CancellableStream<CompletionChunk>;

  /**
   * Embedding for grounding/few-shot retrieval. Adapters that do not
   * support native embedding (e.g., Anthropic without proxy) throw
   * `CompletionError("not_implemented", ...)`.
   */
  embed(text: string): Promise<number[]>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type CompletionErrorCode =
  | "rate_limit"
  | "context_overflow"
  | "auth"
  | "timeout"
  | "network"
  | "vendor_5xx"
  | "bad_request"
  | "cancelled"
  | "not_implemented"
  | "unknown";

export class CompletionError extends Error {
  public readonly code: CompletionErrorCode;
  public readonly retryAfterMs?: number;
  public readonly vendorStatus?: number;
  public readonly vendorMessage?: string;

  constructor(
    code: CompletionErrorCode,
    message: string,
    options: {
      retryAfterMs?: number;
      vendorStatus?: number;
      vendorMessage?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "CompletionError";
    this.code = code;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.vendorStatus !== undefined) {
      this.vendorStatus = options.vendorStatus;
    }
    if (options.vendorMessage !== undefined) {
      this.vendorMessage = options.vendorMessage;
    }
  }
}

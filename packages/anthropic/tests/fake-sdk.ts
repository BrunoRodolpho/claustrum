/**
 * Test fake matching the structural shape of `@anthropic-ai/sdk`.
 *
 * Sufficient surface for the AnthropicProvider tests to exercise:
 *  - non-streaming complete()
 *  - streaming with normalized events
 *  - cancellation (abort spy)
 *  - error translation (throwing scripted errors)
 *
 * We do NOT depend on the real SDK in unit tests. The CI integration test
 * (gated on ANTHROPIC_API_KEY) is left for a future job — this fake proves
 * the contract surface.
 */

import type {
  AnthropicClientLike,
  AnthropicMessageResponse,
  AnthropicMessageStream,
  AnthropicMessagesCreateBody,
  AnthropicStreamEvent,
} from "../src/provider.js";

export interface FakeStreamScript {
  readonly events: ReadonlyArray<AnthropicStreamEvent>;
  readonly finalMessage: AnthropicMessageResponse;
  /** If set, throw this from the iterator AFTER `delayMs` (simulates SDK errors). */
  readonly throwAfter?: { readonly index: number; readonly error: unknown };
}

export interface FakeAnthropicClientOptions {
  readonly completeResponse?: AnthropicMessageResponse;
  readonly completeError?: unknown;
  readonly streamScript?: FakeStreamScript;
  readonly streamError?: unknown;
}

export class FakeAnthropicClient implements AnthropicClientLike {
  public abortSpyCallCount = 0;
  public createCalls: Array<AnthropicMessagesCreateBody> = [];
  public streamCalls: Array<AnthropicMessagesCreateBody> = [];
  private readonly options: FakeAnthropicClientOptions;

  constructor(options: FakeAnthropicClientOptions = {}) {
    this.options = options;
  }

  public readonly messages = {
    create: async (
      body: AnthropicMessagesCreateBody,
      _opts?: { signal?: AbortSignal },
    ): Promise<AnthropicMessageResponse> => {
      this.createCalls.push(body);
      if (this.options.completeError !== undefined) {
        throw this.options.completeError;
      }
      return (
        this.options.completeResponse ?? {
          model: body.model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: "fake-output" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }
      );
    },
    stream: (
      body: AnthropicMessagesCreateBody,
      _opts?: { signal?: AbortSignal },
    ): AnthropicMessageStream => {
      this.streamCalls.push(body);
      return this.buildStream();
    },
  };

  private buildStream(): AnthropicMessageStream {
    const script = this.options.streamScript ?? {
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
      ] as ReadonlyArray<AnthropicStreamEvent>,
      finalMessage: {
        model: "fake-model",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const streamError = this.options.streamError;
    const incrementAbort = (): void => {
      this.abortSpyCallCount += 1;
    };
    let aborted = false;
    let finished = false;
    let abortedDeferred: (() => void) | undefined;

    async function* iterate(): AsyncGenerator<AnthropicStreamEvent> {
      if (streamError !== undefined) {
        throw streamError;
      }
      for (let i = 0; i < script.events.length; i += 1) {
        if (aborted) {
          const err = new Error("aborted");
          err.name = "APIUserAbortError";
          throw err;
        }
        if (script.throwAfter !== undefined && script.throwAfter.index === i) {
          throw script.throwAfter.error;
        }
        yield script.events[i] as AnthropicStreamEvent;
      }
      finished = true;
    }

    const iterator = iterate();

    const stream: AnthropicMessageStream = {
      [Symbol.asyncIterator](): AsyncIterator<AnthropicStreamEvent> {
        return iterator;
      },
      abort(): void {
        incrementAbort();
        if (aborted) {
          return;
        }
        aborted = true;
        if (abortedDeferred !== undefined) {
          abortedDeferred();
        }
      },
      async finalMessage(): Promise<AnthropicMessageResponse> {
        if (aborted) {
          const err = new Error("aborted");
          err.name = "APIUserAbortError";
          throw err;
        }
        if (!finished) {
          // Drain remaining events.
          for await (const _ of { [Symbol.asyncIterator]: () => iterator }) {
            void _;
          }
        }
        return script.finalMessage;
      },
    };
    return stream;
  }
}

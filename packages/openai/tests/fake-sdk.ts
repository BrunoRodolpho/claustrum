/**
 * Test fake matching the structural shape of `openai`.
 *
 * Sufficient surface for the OpenAIProvider tests to exercise:
 *  - non-streaming complete()
 *  - streaming with normalized events
 *  - cancellation via AbortSignal (abort spy)
 *  - tool-call argument stitching across multiple chunks
 *  - embeddings
 *  - error translation
 */

import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionsBody,
  OpenAIClientLike,
  OpenAIEmbeddingResponse,
} from "../src/provider.js";

export interface FakeStreamScript {
  readonly chunks: ReadonlyArray<OpenAIChatCompletionChunk>;
  /** Throw this error after emitting `throwAtChunk` chunks. */
  readonly throwAtChunk?: { readonly index: number; readonly error: unknown };
}

export interface FakeOpenAIClientOptions {
  readonly completeResponse?: OpenAIChatCompletionResponse;
  readonly completeError?: unknown;
  readonly streamScript?: FakeStreamScript;
  readonly streamError?: unknown;
  readonly embeddingResponse?: OpenAIEmbeddingResponse;
  readonly embeddingError?: unknown;
  /** Inject a delay between stream chunks so cancellation can interleave. */
  readonly streamDelayMs?: number;
}

export class FakeOpenAIClient implements OpenAIClientLike {
  public abortSpyCallCount = 0;
  public createChatCalls: Array<{
    body: OpenAIChatCompletionsBody;
    signal?: AbortSignal;
  }> = [];
  public createEmbeddingCalls: Array<{
    model: string;
    input: string | ReadonlyArray<string>;
  }> = [];
  private readonly options: FakeOpenAIClientOptions;

  constructor(options: FakeOpenAIClientOptions = {}) {
    this.options = options;
  }

  public readonly chat = {
    completions: {
      create: (async (
        body: OpenAIChatCompletionsBody,
        opts?: { signal?: AbortSignal },
      ): Promise<
        OpenAIChatCompletionResponse | AsyncIterable<OpenAIChatCompletionChunk>
      > => {
        this.createChatCalls.push({
          body,
          ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
        });
        if (body.stream === true) {
          if (this.options.streamError !== undefined) {
            throw this.options.streamError;
          }
          return this.buildStreamIterable(opts?.signal);
        }
        if (this.options.completeError !== undefined) {
          throw this.options.completeError;
        }
        return (
          this.options.completeResponse ?? {
            id: "cmpl_fake",
            model: body.model,
            choices: [
              {
                message: { content: "fake-output" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }
        );
      }) as OpenAIClientLike["chat"]["completions"]["create"],
    },
  };

  public readonly embeddings = {
    create: async (
      body: { model: string; input: string | ReadonlyArray<string> },
      _opts?: { signal?: AbortSignal },
    ): Promise<OpenAIEmbeddingResponse> => {
      this.createEmbeddingCalls.push(body);
      if (this.options.embeddingError !== undefined) {
        throw this.options.embeddingError;
      }
      return (
        this.options.embeddingResponse ?? {
          data: [{ embedding: [0.1, 0.2, 0.3] }],
        }
      );
    },
  };

  private buildStreamIterable(
    signal?: AbortSignal,
  ): AsyncIterable<OpenAIChatCompletionChunk> {
    const script = this.options.streamScript ?? {
      chunks: [
        {
          choices: [
            {
              index: 0,
              delta: { content: "hello" },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ] as ReadonlyArray<OpenAIChatCompletionChunk>,
    };

    const delayMs = this.options.streamDelayMs ?? 0;
    const incrementAbort = (): void => {
      this.abortSpyCallCount += 1;
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        incrementAbort();
      } else {
        signal.addEventListener(
          "abort",
          () => {
            incrementAbort();
          },
          { once: true },
        );
      }
    }

    async function* iterate(): AsyncGenerator<OpenAIChatCompletionChunk> {
      for (let i = 0; i < script.chunks.length; i += 1) {
        if (signal?.aborted === true) {
          const err = new Error("aborted");
          err.name = "APIUserAbortError";
          throw err;
        }
        if (
          script.throwAtChunk !== undefined &&
          script.throwAtChunk.index === i
        ) {
          throw script.throwAtChunk.error;
        }
        if (delayMs > 0) {
          await new Promise((res) => setTimeout(res, delayMs));
        }
        yield script.chunks[i] as OpenAIChatCompletionChunk;
      }
    }

    return { [Symbol.asyncIterator]: iterate };
  }
}

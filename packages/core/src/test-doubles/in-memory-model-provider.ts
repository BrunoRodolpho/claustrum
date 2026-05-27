/**
 * InMemoryModelProvider — deterministic ModelProvider stub.
 *
 * Used by:
 *  - property tests (no network)
 *  - downstream adapter contract tests (parity baseline)
 *
 * The provider replays a programmable completion script. `complete()`
 * returns the next-in-script Completion; `stream()` slices the same
 * into CompletionChunks; `embed()` returns a deterministic hash-derived
 * vector.
 */

import type {
  CancellableStream,
  Completion,
  CompletionChunk,
  CompletionRequest,
  ModelProvider,
} from "../ports/model-provider.js";

export interface InMemoryModelProviderOptions {
  readonly completions?: ReadonlyArray<Completion>;
  /** When set, `embed()` returns this vector; otherwise derived from text. */
  readonly embedding?: ReadonlyArray<number>;
}

export class InMemoryModelProvider implements ModelProvider {
  private completionCursor = 0;
  private readonly completions: ReadonlyArray<Completion>;
  private readonly embedding: ReadonlyArray<number>;

  public readonly seen: CompletionRequest[] = [];

  constructor(options: InMemoryModelProviderOptions = {}) {
    this.completions = options.completions ?? [
      {
        model: "in-memory",
        stopReason: "end_turn",
        text: "OK",
        inputTokens: 1,
        outputTokens: 1,
      },
    ];
    this.embedding = options.embedding ?? [0, 0, 0, 0];
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    this.seen.push(req);
    const next = this.completions[this.completionCursor % this.completions.length];
    this.completionCursor += 1;
    return next;
  }

  stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
    this.seen.push(req);
    const completion =
      this.completions[this.completionCursor % this.completions.length];
    this.completionCursor += 1;
    let aborted = false;

    async function* gen(): AsyncIterator<CompletionChunk> {
      if (completion.text.length > 0) {
        yield { type: "text_delta", text: completion.text };
      }
      if (aborted) {
        yield { type: "cancelled" };
        return;
      }
      yield {
        type: "done",
        stopReason: completion.stopReason,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      };
    }

    const iterator = gen();
    return {
      [Symbol.asyncIterator](): AsyncIterator<CompletionChunk> {
        return iterator;
      },
      cancel(): void {
        aborted = true;
      },
      get aborted(): boolean {
        return aborted;
      },
    };
  }

  async embed(text: string): Promise<number[]> {
    // Deterministic hash-derived vector. Same input -> same output.
    const base = this.embedding.slice();
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return base.map((v, i) => v + ((hash >> (i % 16)) & 0xff) / 255);
  }
}

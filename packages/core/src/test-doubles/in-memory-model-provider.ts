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
    if (next === undefined) {
      throw new Error("InMemoryModelProvider: no completions configured");
    }
    return next;
  }

  stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
    this.seen.push(req);
    const completion =
      this.completions[this.completionCursor % this.completions.length];
    this.completionCursor += 1;
    if (completion === undefined) {
      throw new Error("InMemoryModelProvider: no completions configured");
    }
    // Re-bind with an explicit type: TS control-flow narrowing from the guard
    // above does not propagate into the nested gen() generator closure.
    const active: Completion = completion;
    let aborted = false;

    async function* gen(): AsyncIterator<CompletionChunk> {
      if (active.text.length > 0) {
        yield { type: "text_delta", text: active.text };
      }
      if (aborted) {
        yield { type: "cancelled" };
        return;
      }
      yield {
        type: "done",
        stopReason: active.stopReason,
        inputTokens: active.inputTokens,
        outputTokens: active.outputTokens,
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

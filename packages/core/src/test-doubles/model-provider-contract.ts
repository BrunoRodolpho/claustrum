/**
 * Shared ModelProvider contract test.
 *
 * Adapters (`@claustrum/anthropic`, `@claustrum/openai`, future ones)
 * import `runModelProviderContract` and pass a factory that returns a
 * provider instance. The runner exercises the port:
 *  - `complete()` returns a Completion
 *  - `stream()` yields chunks and terminates with `done` or `cancelled`
 *  - `cancel()` is idempotent and observable via `aborted`
 *  - `embed()` returns a number[] (or throws `not_implemented`)
 *
 * The runner is vitest-agnostic: it calls a generic `describe` + `it`
 * pair the adapter supplies, so adapters can run it under their own
 * test runner if needed.
 */

import type { ModelProvider } from "../ports/model-provider.js";

export interface ContractTestSurface {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => void | Promise<void>): void;
  expect<T>(actual: T): {
    toBeDefined(): void;
    toBe(expected: T): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: unknown): void;
  };
}

export interface ContractOptions {
  readonly factory: () => ModelProvider | Promise<ModelProvider>;
  readonly surface: ContractTestSurface;
  /** Skip embedding assertions for providers that don't support embed. */
  readonly skipEmbed?: boolean;
}

export function runModelProviderContract(options: ContractOptions): void {
  const { describe, it, expect } = options.surface;

  describe("ModelProvider contract", () => {
    it("complete() returns a Completion with stopReason + tokens", async () => {
      const provider = await options.factory();
      const result = await provider.complete({
        model: "contract-test",
        messages: [{ role: "user", content: "ping" }],
      });
      expect(result.stopReason).toBeDefined();
      expect(result.inputTokens).toBeGreaterThan(-1);
      expect(result.outputTokens).toBeGreaterThan(-1);
    });

    it("stream() yields chunks terminating with done or cancelled", async () => {
      const provider = await options.factory();
      const stream = provider.stream({
        model: "contract-test",
        messages: [{ role: "user", content: "ping" }],
      });
      const seen: string[] = [];
      for await (const chunk of stream) {
        seen.push(chunk.type);
        if (chunk.type === "done" || chunk.type === "cancelled") break;
      }
      // Assert the stream terminates with EXACTLY ONE terminal marker that
      // is either "done" or "cancelled".  Two sub-checks:
      //   (1) Exactly one terminal appears in the collected chunks.
      //   (2) That terminal is the last element (stream stopped at it).
      const terminals = seen.filter((t) => t === "done" || t === "cancelled");
      expect(terminals.length).toBe(1);
      expect(seen[seen.length - 1]).toBe(terminals[0]);
    });

    it("stream() cancel() is idempotent and observable", async () => {
      const provider = await options.factory();
      const stream = provider.stream({
        model: "contract-test",
        messages: [{ role: "user", content: "ping" }],
      });
      stream.cancel();
      stream.cancel();
      // Drain to ensure the generator returns cleanly.
      for await (const _chunk of stream) {
        void _chunk;
      }
      expect(stream.aborted).toBe(true);
    });

    if (options.skipEmbed !== true) {
      it("embed() returns a number[]", async () => {
        const provider = await options.factory();
        const vector = await provider.embed("hello");
        expect(vector.length).toBeGreaterThan(0);
      });
    }
  });
}

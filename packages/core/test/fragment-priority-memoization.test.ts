/**
 * PerformanceReviewer-003 — the priority-ordered fragment projection is
 * memoized in the FragmentRegistry; the composer no longer re-sorts per turn.
 *
 * `PromptComposer.compose` used to do `.list().filter(applies).slice().sort()`
 * — four allocations + a full sort every turn. The fix caches the
 * ctx-INDEPENDENT priority order in the registry (`priorityOrdered()`),
 * invalidated on `register()`; the composer applies the ctx-dependent
 * `applies(ctx)` filter to that cached list FRESH per compose. Filtering a
 * stably-sorted list preserves relative order, so the emitted
 * `fragmentManifest` is byte-for-byte identical to the old path.
 *
 * These tests pin the invalidation discipline:
 *  (a) register() invalidates  — a fragment registered AFTER a compose appears
 *      in the next compose's manifest.
 *  (b) ordering is stable      — priority-ASC, with insertion order as the
 *      stable secondary key; the per-ctx `applies` filter does not reorder.
 *  (c) sort runs once          — `priorityOrdered()` returns the SAME array
 *      reference across same-state calls (proof it was not re-sorted);
 *      register() invalidates to a fresh reference.
 */

import { describe, it, expect } from "vitest";
import {
  createFragmentRegistry,
  createPromptComposer,
  type PromptContext,
  type PromptFragment,
} from "../src/index.js";

function makeFragment(
  input: Partial<PromptFragment> & Pick<PromptFragment, "id" | "priority">,
): PromptFragment {
  return {
    id: input.id,
    hash: input.hash ?? `hash-${input.id}`,
    priority: input.priority,
    tokens: input.tokens ?? 1,
    content: input.content ?? (() => input.id),
    applies: input.applies ?? (() => true),
  };
}

function makeCtx(): PromptContext {
  return {
    cognition: {
      perception: {
        text: "ping",
        channel: "web",
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      memory: {
        customerId: "c",
        episodic: [],
        semantic: [],
        procedural: [],
        relational: [],
        assembledAt: "2026-01-01T00:00:00.000Z",
      },
      retrieval: {
        docs: [],
        retrievedAt: "2026-01-01T00:00:00.000Z",
        modelId: "test",
      },
      tenantId: "t",
      locale: "pt-BR",
      conversationId: "conv",
      turnId: "turn",
    },
  } as unknown as PromptContext;
}

const BUDGET = { maxTokens: 10_000 };

describe("priorityOrdered() cache invalidation (PerformanceReviewer-003)", () => {
  it("(c) returns the same reference across same-state calls; register() invalidates", () => {
    const reg = createFragmentRegistry();
    reg.register(makeFragment({ id: "a", priority: 2 }));
    reg.register(makeFragment({ id: "b", priority: 1 }));

    const first = reg.priorityOrdered();
    const second = reg.priorityOrdered();
    // Same reference => the sort did NOT re-run on the second call.
    expect(second).toBe(first);
    // Cached order is correct (priority ASC).
    expect(first.map((f) => f.id)).toEqual(["b", "a"]);

    // Mutation invalidates -> a fresh, re-sorted reference.
    reg.register(makeFragment({ id: "c", priority: 0 }));
    const third = reg.priorityOrdered();
    expect(third).not.toBe(first);
    expect(third.map((f) => f.id)).toEqual(["c", "b", "a"]);
  });

  it("(b) ordering is priority-ASC with insertion order as the stable secondary key", () => {
    const reg = createFragmentRegistry();
    // Two fragments share priority 1 — insertion order (x before y) must hold.
    reg.register(makeFragment({ id: "x", priority: 1 }));
    reg.register(makeFragment({ id: "hi", priority: 5 }));
    reg.register(makeFragment({ id: "y", priority: 1 }));
    reg.register(makeFragment({ id: "lo", priority: 0 }));

    expect(reg.priorityOrdered().map((f) => f.id)).toEqual([
      "lo",
      "x",
      "y",
      "hi",
    ]);
  });
});

describe("composer reads the cached order (PerformanceReviewer-003)", () => {
  it("(a) a fragment registered after a compose appears in the next compose manifest", async () => {
    const reg = createFragmentRegistry();
    reg.register(makeFragment({ id: "a", priority: 1 }));
    const composer = createPromptComposer({ registry: reg });

    const first = await composer.compose(makeCtx(), BUDGET);
    expect(first.fragmentManifest).toEqual(["a"]);

    // Register AFTER the first compose populated the cache.
    reg.register(makeFragment({ id: "b", priority: 0 }));

    const second = await composer.compose(makeCtx(), BUDGET);
    // b (priority 0) sorts before a (priority 1) — and it is PRESENT.
    expect(second.fragmentManifest).toEqual(["b", "a"]);
  });

  it("(b) manifest order matches priority-ASC and is stable across repeated composes", async () => {
    const reg = createFragmentRegistry();
    reg.register(makeFragment({ id: "mid", priority: 5 }));
    reg.register(makeFragment({ id: "top", priority: 0 }));
    reg.register(makeFragment({ id: "mid2", priority: 5 }));
    reg.register(makeFragment({ id: "low", priority: 9 }));
    const composer = createPromptComposer({ registry: reg });

    const expected = ["top", "mid", "mid2", "low"];
    const a = await composer.compose(makeCtx(), BUDGET);
    const b = await composer.compose(makeCtx(), BUDGET);
    expect(a.fragmentManifest).toEqual(expected);
    expect(b.fragmentManifest).toEqual(expected);
  });

  it("ctx-dependent applies() filter runs FRESH per compose against the cached order", async () => {
    // `applies` keys off ctx.extra.turn — same registry/cache, different ctx
    // must yield different (correctly-filtered) manifests, order preserved.
    const reg = createFragmentRegistry();
    reg.register(
      makeFragment({
        id: "always",
        priority: 0,
      }),
    );
    reg.register(
      makeFragment({
        id: "only-second",
        priority: 1,
        applies: (ctx) => (ctx.extra as { turn: number }).turn === 2,
      }),
    );
    const composer = createPromptComposer({ registry: reg });

    const ctx1 = { ...makeCtx(), extra: { turn: 1 } } as PromptContext;
    const ctx2 = { ...makeCtx(), extra: { turn: 2 } } as PromptContext;

    expect((await composer.compose(ctx1, BUDGET)).fragmentManifest).toEqual([
      "always",
    ]);
    expect((await composer.compose(ctx2, BUDGET)).fragmentManifest).toEqual([
      "always",
      "only-second",
    ]);
    // Re-running ctx1 still excludes only-second (no stale cross-ctx leak).
    expect((await composer.compose(ctx1, BUDGET)).fragmentManifest).toEqual([
      "always",
    ]);
  });
});

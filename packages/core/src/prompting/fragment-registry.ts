/**
 * PromptFragment + FragmentRegistry — content-addressed prompt building blocks.
 *
 * Per PART I §"Prompt synthesis architecture":
 *  - prompts are NOT strings — they're composable graphs of versioned,
 *    content-addressed fragments
 *  - fragments carry priority (0 = inviolable; higher = drops first)
 *  - the composer decides what FITS, not what to INCLUDE (policy decides
 *    inclusion via `applies`)
 *  - the manifest of fragment IDs included is recorded in every LLM trace,
 *    enabling replay-by-hash months later
 */

import type { CognitiveState } from "../ports/planner.js";

export interface PromptContext {
  readonly cognition: CognitiveState;
  readonly capabilities?: ReadonlyArray<string>;
  readonly fewShots?: ReadonlyArray<unknown>;
  readonly extra?: Record<string, unknown>;
}

export interface PromptFragment {
  readonly id: string;
  readonly hash: string;
  /** 0 = inviolable (NEVER dropped); higher number = drops first under pressure. */
  readonly priority: number;
  /** Estimated token cost. The composer uses this for budget eviction. */
  readonly tokens: number;
  readonly content: (ctx: PromptContext) => string | Promise<string>;
  /** Predicate: should this fragment apply this turn? */
  readonly applies: (ctx: PromptContext) => boolean;
}

export interface FragmentRegistry {
  register(fragment: PromptFragment): void;
  list(): ReadonlyArray<PromptFragment>;
  /**
   * The registered fragments projected in priority-ASC order (lower priority
   * drops LAST under budget pressure), with insertion order as the stable
   * secondary key. This ordering is ctx-INDEPENDENT, so it is computed once
   * and cached; the composer applies its ctx-dependent `applies(ctx)` filter
   * to this list FRESH per turn rather than re-sorting every compose
   * (PerformanceReviewer-003). Invalidated on every fragment mutation.
   */
  priorityOrdered(): ReadonlyArray<PromptFragment>;
  byId(id: string): PromptFragment | undefined;
}

export function createFragmentRegistry(): FragmentRegistry {
  const byId = new Map<string, PromptFragment>();

  /**
   * Cached priority-ordered projection. `undefined` = stale; recomputed
   * lazily on the next `priorityOrdered()` read. Invalidated on `register()`
   * (the only fragment mutation). Caches ONLY the ctx-independent sort — the
   * `applies(ctx)` filter stays in the composer and runs per ctx.
   */
  let ordered: ReadonlyArray<PromptFragment> | undefined;

  return {
    register(fragment: PromptFragment): void {
      byId.set(fragment.id, fragment);
      // Membership changed -> the cached priority order is stale.
      ordered = undefined;
    },
    list(): ReadonlyArray<PromptFragment> {
      return Array.from(byId.values());
    },
    priorityOrdered(): ReadonlyArray<PromptFragment> {
      // Stable sort: `Array.prototype.sort` is stable in modern Node, and
      // `byId.values()` yields insertion order — so equal-priority fragments
      // keep registration order as the secondary key.
      return (ordered ??= Array.from(byId.values()).sort(
        (a, b) => a.priority - b.priority,
      ));
    },
    byId(id: string): PromptFragment | undefined {
      return byId.get(id);
    },
  };
}

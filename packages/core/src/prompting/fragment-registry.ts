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
  byId(id: string): PromptFragment | undefined;
}

export function createFragmentRegistry(): FragmentRegistry {
  const byId = new Map<string, PromptFragment>();
  return {
    register(fragment: PromptFragment): void {
      byId.set(fragment.id, fragment);
    },
    list(): ReadonlyArray<PromptFragment> {
      return Array.from(byId.values());
    },
    byId(id: string): PromptFragment | undefined {
      return byId.get(id);
    },
  };
}

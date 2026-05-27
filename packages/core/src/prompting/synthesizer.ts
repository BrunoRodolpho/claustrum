/**
 * PromptComposer — priority-ordered fragment selection + token-budget
 * eviction + manifest output.
 *
 * Per the three architectural commitments (PART I §"Prompt synthesis
 * architecture"):
 *
 *   1. priority-ordered fragments with token-budget eviction
 *   2. few-shots as INDEXED retrieval (not static assets)
 *   3. fragments are versioned content-addressed assets (manifest replay)
 *
 * The composer is intentionally synchronous-friendly — fragment content
 * may be sync or async; the composer awaits as needed and emits a
 * deterministic manifest.
 */

import type { FewShotExample } from "../ports/few-shot.js";
import type {
  FragmentRegistry,
  PromptContext,
  PromptFragment,
} from "./fragment-registry.js";

export interface TokenBudget {
  readonly maxTokens: number;
  /** Optional per-fragment minimum (a fragment with tokens > this is always evaluated). */
  readonly perFragmentSoftMin?: number;
}

export interface ComposedMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ComposedPrompt {
  readonly system: string;
  readonly messages: ReadonlyArray<ComposedMessage>;
  readonly fewShots: ReadonlyArray<FewShotExample>;
  /**
   * Ordered list of fragment IDs included this turn. Recorded into
   * `LLMTrace.promptManifest` so the exact prompt can be replayed by
   * hash — even if live fragments later evolve.
   */
  readonly fragmentManifest: ReadonlyArray<string>;
  /** Sum of `fragment.tokens` for every included fragment. */
  readonly estimatedTokens: number;
}

export interface PromptComposer {
  compose(ctx: PromptContext, budget: TokenBudget): Promise<ComposedPrompt>;
}

export interface ComposerOptions {
  readonly registry: FragmentRegistry;
  /** Optional few-shot selection. Receives the same PromptContext + budget. */
  readonly fewShots?: (
    ctx: PromptContext,
    budget: TokenBudget,
  ) => Promise<ReadonlyArray<FewShotExample>>;
}

export function createPromptComposer(
  options: ComposerOptions,
): PromptComposer {
  return {
    async compose(
      ctx: PromptContext,
      budget: TokenBudget,
    ): Promise<ComposedPrompt> {
      // 1. Filter by `applies`.
      const applicable = options.registry
        .list()
        .filter((fragment) => fragment.applies(ctx));

      // 2. Sort by priority ASC — lower priority drops LAST under pressure.
      //    Stable secondary key: registry insertion order. (Array.sort in
      //    modern Node is stable.)
      const sorted = applicable.slice().sort((a, b) => a.priority - b.priority);

      // 3. Token-budget eviction: include greedily in priority order until
      //    we'd exceed the budget. Priority-0 fragments are inviolable —
      //    they MUST fit even if the budget is overshot. (Surfacing the
      //    overshoot is up to the caller's LLM provider.)
      const selected: PromptFragment[] = [];
      let used = 0;
      for (const fragment of sorted) {
        const isInviolable = fragment.priority === 0;
        const fits = used + fragment.tokens <= budget.maxTokens;
        if (fits || isInviolable) {
          selected.push(fragment);
          used += fragment.tokens;
        }
      }

      // 4. Realize content. Fragments appear in priority order in the
      //    system prompt; adopters can override segmentation via custom
      //    composer subclasses (out of scope here).
      const contents = await Promise.all(
        selected.map(async (fragment) => ({
          id: fragment.id,
          text: await fragment.content(ctx),
        })),
      );

      const systemText = contents.map((c) => c.text).join("\n\n");

      const fewShots: ReadonlyArray<FewShotExample> =
        options.fewShots !== undefined
          ? await options.fewShots(ctx, budget)
          : [];

      const messages: ReadonlyArray<ComposedMessage> = [
        { role: "user", content: ctx.cognition.perception.text },
      ];

      const fragmentManifest = selected.map((fragment) => fragment.id);

      return {
        system: systemText,
        messages,
        fewShots,
        fragmentManifest,
        estimatedTokens: used,
      };
    },
  };
}

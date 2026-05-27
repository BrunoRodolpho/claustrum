/**
 * FewShotIndex — indexed retrieval of conversational exemplars.
 *
 * Per the Prompt Synthesis Architecture (PART I), few-shots are NOT
 * static assets. They are:
 *  - indexed (retrieved per turn by intent kind, risk, channel, etc.)
 *  - typed (`goldOutcome: { envelopes, decision }` is the regression oracle)
 *  - versioned (the `id` is the stable key; the embedding may change)
 *
 * `goldOutcome` is the load-bearing field: when a Pack policy changes,
 * re-run all few-shots through the current Conductor + Adjudicator and
 * verify decisions still match. This makes few-shots BOTH teaching data
 * AND a drift detector.
 */

import type { Decision, IntentEnvelope } from "@adjudicate/core";

export interface FewShotMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface FewShotExample {
  readonly id: string;
  readonly scenario: string;
  readonly conversation: ReadonlyArray<FewShotMessage>;
  /**
   * The gold outcome. When a policy changes, re-running this example
   * through the current Conductor MUST produce `envelopes` + `decision`
   * that match (envelope equality by intentHash; decision equality by
   * kind + basis).
   */
  readonly goldOutcome: {
    readonly envelopes: ReadonlyArray<IntentEnvelope>;
    readonly decision: Decision;
  };
  readonly tags: ReadonlyArray<string>;
  readonly embedding?: ReadonlyArray<number>;
}

export interface FewShotQuery {
  readonly intentKind?: string;
  readonly riskScore?: number;
  readonly toolTypes?: ReadonlyArray<string>;
  readonly tenant?: string;
  readonly locale?: string;
  readonly channel?: string;
  readonly planEmbedding?: ReadonlyArray<number>;
}

export interface FewShotIndex {
  select(query: FewShotQuery, k: number): Promise<ReadonlyArray<FewShotExample>>;
  register(example: FewShotExample): Promise<void>;
}

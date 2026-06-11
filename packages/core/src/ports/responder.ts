/**
 * ResponderPort — generates the user-facing reply.
 *
 * Called during the SYNTHESIZE phase. Reads the decision + plan +
 * grounding + voice and produces a `DraftResponse`. If the runtime
 * has `adjudicateOutput()` wired, the draft is then gated by the
 * kernel before being rendered.
 *
 * Streaming responder support lives behind `CancellableStream`
 * (see model-provider.ts) — adapters that stream wrap chunks into
 * RenderedResponse fragments.
 */

import type { Decision } from "@adjudicate/core";
import type { ChannelArtifact } from "./channel.js";
import type { CognitiveState, Plan, TokenUsage } from "./planner.js";

export interface DraftResponse {
  readonly text: string;
  /**
   * Structured artifacts forwarded onto the `RenderedResponse` (cards,
   * buttons, recipient hints, etc.). Typed as {@link ChannelArtifact} so the
   * draft → render copy is a typed pass-through (APIReviewer-018).
   */
  readonly artifacts?: ReadonlyArray<ChannelArtifact>;
  readonly meta?: Record<string, unknown>;
  /**
   * Token usage of the synthesis model call (cost accounting, F4). Optional +
   * additive; summed with `plan.usage` onto the TurnRecord by `handleTurn`.
   */
  readonly usage?: TokenUsage;
}

export interface OutputContext {
  readonly cognition: CognitiveState;
  readonly decision: Decision;
  readonly plan: Plan;
  readonly tenantId: string;
  readonly turnId: string;
}

export interface ResponderPort {
  respond(input: {
    readonly cognition: CognitiveState;
    readonly decision: Decision;
    readonly plan: Plan;
    readonly acted?: unknown;
    readonly voice?: Record<string, unknown>;
  }): Promise<DraftResponse>;
}

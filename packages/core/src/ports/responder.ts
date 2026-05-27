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
import type { CognitiveState, Plan } from "./planner.js";

export interface DraftResponse {
  readonly text: string;
  readonly artifacts?: ReadonlyArray<unknown>;
  readonly meta?: Record<string, unknown>;
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

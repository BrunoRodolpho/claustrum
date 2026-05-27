/**
 * PlannerPort — proposes IntentEnvelope[] from CognitiveState.
 *
 * The planner is the "reasoning" half of the cognitive loop. It reads
 * the assembled CognitiveState (perception + memory + retrieval +
 * session) and proposes one or more envelopes describing what mutations
 * should happen. NO mutations occur here — those are gated by
 * `adjudicate()`.
 *
 * Plan invariants (enforced by property tests in test/properties/):
 *  - Every proposed envelope has `actor.principal` set.
 *  - Envelopes carry tenant-appropriate `taint`.
 *  - When `envelopes.length > 1`, `handleTurn` routes to `adjudicatePlan`.
 */

// TODO: re-export from @adjudicate/core when public API exposes them
import type { IntentEnvelope } from "@adjudicate/core";
import type { MemorySnapshot } from "./memory.js";
import type { Perception, RetrievedDocs } from "./grounding.js";

/**
 * What the planner sees this turn. Assembled by the cognition phase
 * of `handleTurn` from memory + grounding + session + tenant policy.
 */
export interface CognitiveState {
  readonly perception: Perception;
  readonly memory: MemorySnapshot;
  readonly retrieval: RetrievedDocs;
  readonly workingMemory?: string;
  readonly tenantId: string;
  readonly locale: string;
  readonly conversationId: string;
  readonly turnId: string;
}

export interface Plan {
  /**
   * One or more proposed envelopes. `handleTurn` routes by length:
   * length 1 -> `adjudicate()`; length > 1 -> `adjudicatePlan()`.
   * length 0 is valid — means "no mutation; the response phase still runs."
   */
  readonly envelopes: ReadonlyArray<IntentEnvelope>;
  /** Free-form rationale for the trace. NEVER user-facing. */
  readonly rationale?: string;
  /** Optional capability ids the LLM expressed (for telemetry). */
  readonly capabilities?: ReadonlyArray<string>;
  /** Tool calls the LLM made for read-only enrichment (no envelope). */
  readonly readToolCalls?: ReadonlyArray<{
    readonly name: string;
    readonly input: unknown;
  }>;
}

export interface PlannerPort {
  propose(state: CognitiveState): Promise<Plan>;
}

/**
 * MemoryPort — runtime-owned memory + read-side window into the kernel
 * audit ledger.
 *
 * Five memory kinds (see PART I §"Memory — five kinds, two sources of
 * truth"):
 *  - episodic   — conversation history
 *  - semantic   — facts about the customer
 *  - procedural — learned workflows
 *  - relational — emotional/social continuity
 *  - operational — past mutations (LIVES IN THE KERNEL — accessed via
 *    `recentActions()` which routes through `Adjudicator.replayEnvelopesByCustomerId`).
 *    The conformance suite enforces "no raw intent_audit SQL" (CC-005).
 *
 * Hot-path budget: `recall()` p99 < 100ms. Adapters cache aggressively
 * (Redis snapshot, write-through on `observe()`).
 */

import type { AuditRecord } from "@adjudicate/core";
import type { Perception } from "./grounding.js";

export interface MemoryItem {
  readonly id: string;
  readonly kind: "episodic" | "semantic" | "procedural" | "relational";
  readonly content: string;
  readonly confidence?: number;
  readonly tags?: ReadonlyArray<string>;
  readonly createdAt: string;
}

export interface MemorySnapshot {
  readonly customerId: string;
  readonly episodic: ReadonlyArray<MemoryItem>;
  readonly semantic: ReadonlyArray<MemoryItem>;
  readonly procedural: ReadonlyArray<MemoryItem>;
  readonly relational: ReadonlyArray<MemoryItem>;
  /** Wall-clock at which the snapshot was assembled. */
  readonly assembledAt: string;
}

/**
 * What the runtime tells memory after a turn lands. Fields are optional
 * so partial observations (refusal-only, error-only) are still recordable.
 */
export interface TurnOutcome {
  readonly turnId: string;
  readonly conversationId: string;
  readonly perception?: Perception;
  readonly userText?: string;
  readonly responseText?: string;
  readonly decisionKind?: string;
  readonly intentHash?: string;
  readonly at: string;
}

export interface MemoryPort {
  /** Hot path. < 100ms p99. */
  recall(
    customerId: string,
    perception: Perception,
  ): Promise<MemorySnapshot>;

  /** Write turn artifacts back. May be async-batched by adapters. */
  observe(customerId: string, turn: TurnOutcome): Promise<void>;

  /** Semantic search across non-operational memory kinds. */
  search(
    customerId: string,
    query: { readonly semantic?: string; readonly tags?: ReadonlyArray<string> },
    k: number,
  ): Promise<ReadonlyArray<MemoryItem>>;

  /**
   * Operational memory — past mutations. MUST route through the
   * Adjudicator port. Adapters that touch `intent_audit` directly fail
   * conformance check CC-005.
   */
  recentActions(
    customerId: string,
    since: Date,
  ): Promise<ReadonlyArray<AuditRecord>>;
}

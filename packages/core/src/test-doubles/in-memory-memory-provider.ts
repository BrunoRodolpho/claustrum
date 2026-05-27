/**
 * InMemoryMemoryProvider — MemoryPort test-double.
 *
 * Buffers TurnOutcomes in memory; `recall` returns a snapshot stitched
 * from the buffer; `recentActions` returns an empty array (the
 * production memory adapter routes through Adjudicator — the conformance
 * test enforces this).
 */

import type { AuditRecord } from "@adjudicate/core";
import type { Perception } from "../ports/grounding.js";
import type {
  MemoryItem,
  MemoryPort,
  MemorySnapshot,
  TurnOutcome,
} from "../ports/memory.js";

export class InMemoryMemoryProvider implements MemoryPort {
  public readonly recalls: Array<{
    readonly customerId: string;
    readonly perception: Perception;
  }> = [];
  public readonly observed: TurnOutcome[] = [];

  async recall(
    customerId: string,
    perception: Perception,
  ): Promise<MemorySnapshot> {
    this.recalls.push({ customerId, perception });
    const items = this.observed.filter(
      (o): o is TurnOutcome & { userText: string } =>
        typeof o.userText === "string",
    );
    const episodic: MemoryItem[] = items.map((outcome, index) => ({
      id: `mem-${index}`,
      kind: "episodic",
      content: outcome.userText,
      createdAt: outcome.at,
    }));
    return {
      customerId,
      episodic,
      semantic: [],
      procedural: [],
      relational: [],
      assembledAt: new Date().toISOString(),
    };
  }

  async observe(_customerId: string, turn: TurnOutcome): Promise<void> {
    void _customerId;
    this.observed.push(turn);
  }

  async search(): Promise<ReadonlyArray<MemoryItem>> {
    return [];
  }

  async recentActions(
    _customerId: string,
    _since: Date,
  ): Promise<ReadonlyArray<AuditRecord>> {
    void _customerId;
    void _since;
    // Production adapters MUST route through the Adjudicator port; the
    // in-memory double returns empty so tests don't depend on a kernel.
    return [];
  }
}

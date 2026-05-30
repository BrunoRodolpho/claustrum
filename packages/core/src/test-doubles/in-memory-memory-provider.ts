/**
 * InMemoryMemoryProvider — MemoryPort test-double.
 *
 * Buffers TurnOutcomes in memory; `recall` returns a snapshot stitched
 * from the buffer; `recentActions` returns an empty array (the
 * production memory adapter routes through Adjudicator — the conformance
 * test enforces this).
 *
 * @param maxBuffered - Maximum entries kept in `observed` and `recalls`
 *   (ring; oldest trimmed first).  Defaults to 1 000 so property tests
 *   with hundreds of turns never grow the process unboundedly.  Pass
 *   `Infinity` to restore the old unbounded behaviour.
 */

import type { AuditRecord } from "@adjudicate/core";
import type { Perception } from "../ports/grounding.js";
import type {
  MemoryItem,
  MemoryPort,
  MemorySnapshot,
  TurnOutcome,
} from "../ports/memory.js";

const DEFAULT_MAX_BUFFERED = 1_000;

export interface InMemoryMemoryProviderOptions {
  /** Maximum records retained in `observed` and `recalls` (oldest trimmed). Default 1 000. */
  readonly maxBuffered?: number;
}

export class InMemoryMemoryProvider implements MemoryPort {
  public readonly recalls: Array<{
    readonly customerId: string;
    readonly perception: Perception;
  }> = [];
  public readonly observed: TurnOutcome[] = [];

  private readonly maxBuffered: number;

  constructor(options: InMemoryMemoryProviderOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  }

  /** Clear all buffered records. Useful between test cases. */
  clear(): void {
    this.recalls.length = 0;
    this.observed.length = 0;
  }

  async recall(
    customerId: string,
    perception: Perception,
  ): Promise<MemorySnapshot> {
    this.recalls.push({ customerId, perception });
    if (this.recalls.length > this.maxBuffered) {
      this.recalls.shift();
    }
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
    if (this.observed.length > this.maxBuffered) {
      this.observed.shift();
    }
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

/**
 * RecordingTelemetrySink — TelemetryPort test-double.
 *
 * Buffers every emission for assertion. Property tests use this to
 * verify "the prompt manifest is included in every LLM trace" and
 * "turn telemetry has the right decision kind".
 *
 * @param maxBuffered - Maximum entries kept per buffer (ring; oldest
 *   trimmed first).  Defaults to 1 000 so property tests with hundreds
 *   of turns never grow the process unboundedly.  Pass `Infinity` to
 *   restore the old unbounded behaviour.
 */

import type {
  LLMTrace,
  MemoryAccess,
  TelemetryPort,
  TurnRecord,
} from "../ports/telemetry.js";

const DEFAULT_MAX_BUFFERED = 1_000;

export interface RecordingTelemetrySinkOptions {
  /** Maximum records retained per buffer (oldest trimmed). Default 1 000. */
  readonly maxBuffered?: number;
}

export class RecordingTelemetrySink implements TelemetryPort {
  public readonly turns: TurnRecord[] = [];
  public readonly traces: LLMTrace[] = [];
  public readonly memoryAccesses: MemoryAccess[] = [];

  private readonly maxBuffered: number;

  constructor(options: RecordingTelemetrySinkOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  }

  /** Clear all buffered records. Useful between test cases. */
  clear(): void {
    this.turns.length = 0;
    this.traces.length = 0;
    this.memoryAccesses.length = 0;
  }

  async emitTurn(turn: TurnRecord): Promise<void> {
    this.turns.push(turn);
    if (this.turns.length > this.maxBuffered) {
      this.turns.shift();
    }
  }

  async emitLLMTrace(trace: LLMTrace): Promise<void> {
    this.traces.push(trace);
    if (this.traces.length > this.maxBuffered) {
      this.traces.shift();
    }
  }

  async emitMemoryAccess(access: MemoryAccess): Promise<void> {
    this.memoryAccesses.push(access);
    if (this.memoryAccesses.length > this.maxBuffered) {
      this.memoryAccesses.shift();
    }
  }
}

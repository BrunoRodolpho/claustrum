/**
 * RecordingTelemetrySink — TelemetryPort test-double.
 *
 * Buffers every emission for assertion. Property tests use this to
 * verify "the prompt manifest is included in every LLM trace" and
 * "turn telemetry has the right decision kind".
 */

import type {
  LLMTrace,
  MemoryAccess,
  TelemetryPort,
  TurnRecord,
} from "../ports/telemetry.js";

export class RecordingTelemetrySink implements TelemetryPort {
  public readonly turns: TurnRecord[] = [];
  public readonly traces: LLMTrace[] = [];
  public readonly memoryAccesses: MemoryAccess[] = [];

  async emitTurn(turn: TurnRecord): Promise<void> {
    this.turns.push(turn);
  }

  async emitLLMTrace(trace: LLMTrace): Promise<void> {
    this.traces.push(trace);
  }

  async emitMemoryAccess(access: MemoryAccess): Promise<void> {
    this.memoryAccesses.push(access);
  }
}

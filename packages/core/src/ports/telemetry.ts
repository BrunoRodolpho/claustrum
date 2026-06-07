/**
 * TelemetryPort — runtime-owned telemetry, three streams.
 *
 * Three independent sinks, runtime-owned, kernel-correlated by `intentHash`:
 *  - emitTurn       — per-turn record (channel, decision kind, latency)
 *  - emitLLMTrace   — per-LLM-call record (prompt manifest, completion, tokens)
 *  - emitMemoryAccess — per-memory-read record (recall timing, cache hit)
 *
 * CRITICAL: the LLM-trace store has SEPARATE retention from the audit
 * ledger (PART I §"Telemetry + LLM-trace store"). Prompts + completions
 * are higher-PII than audit records — typically shorter retention,
 * regional sharding, customer-level deletion. Kernel audit stays
 * regulator-grade.
 */

export interface TurnRecord {
  /**
   * Telemetry schema version (APIReviewer-015). Lets the LLM-trace / turn store
   * evolve its shape without ambiguity on read-back. Stamped by the runtime at
   * emit (`TELEMETRY_SCHEMA_VERSION`); optional so pre-versioned records still
   * load. Distinct from — and orthogonal to — the kernel's audit recipe.
   */
  readonly schemaVersion?: number;
  readonly turnId: string;
  readonly conversationId: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly inboundText?: string;
  readonly responseText?: string;
  readonly decisionKind?: string;
  readonly intentHash?: string;
  readonly auditHash?: string;
  /**
   * Total model token usage for the turn (cost accounting, F4). Summed by
   * `handleTurn` from `plan.usage` + `draft.usage`. Optional + additive:
   * absent on pre-versioned records and when no planner/responder reported
   * usage. LLM-trace retention is separate from the audit ledger.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs: number;
  readonly at: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface LLMTrace {
  /** Telemetry schema version (APIReviewer-015). See TurnRecord.schemaVersion. */
  readonly schemaVersion?: number;
  readonly turnId: string;
  /** Correlation key to the kernel's AuditRecord. */
  readonly intentHash?: string;
  /** Fragment hashes from PromptComposer — replay key. */
  readonly promptManifest: ReadonlyArray<string>;
  readonly model: string;
  readonly temperature: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * PII-scrubbed completion text. Unbounded by type — adopters with a storage
   * budget should pass traces through `boundLLMTrace()` before emit to cap this
   * (and the diagnostic arrays below) and stamp the schema version
   * (APIReviewer-015 size-budget).
   */
  readonly completion: string;
  /**
   * Per-token logprobs — OPT-IN diagnostic. Large and rarely needed in
   * production; omit unless actively debugging model calibration.
   */
  readonly logprobs?: ReadonlyArray<number>;
  /**
   * Raw tool-call payloads — OPT-IN diagnostic. Unbounded; omit (or bound via
   * `boundLLMTrace`) in steady state.
   */
  readonly toolCallsRaw?: ReadonlyArray<unknown>;
  readonly durationMs: number;
  readonly at: string;
}

export interface MemoryAccess {
  readonly turnId: string;
  readonly customerId: string;
  readonly kind: "recall" | "search" | "observe" | "recentActions";
  readonly cacheHit?: boolean;
  readonly durationMs: number;
  readonly itemCount?: number;
  readonly at: string;
}

export interface TelemetryPort {
  emitTurn(turn: TurnRecord): Promise<void>;
  emitLLMTrace(trace: LLMTrace): Promise<void>;
  emitMemoryAccess(access: MemoryAccess): Promise<void>;
}

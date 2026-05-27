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
  readonly durationMs: number;
  readonly at: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface LLMTrace {
  readonly turnId: string;
  /** Correlation key to the kernel's AuditRecord. */
  readonly intentHash?: string;
  /** Fragment hashes from PromptComposer — replay key. */
  readonly promptManifest: ReadonlyArray<string>;
  readonly model: string;
  readonly temperature: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** PII-scrubbed completion text. */
  readonly completion: string;
  readonly logprobs?: ReadonlyArray<number>;
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

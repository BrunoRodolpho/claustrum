/**
 * Telemetry schema version + size-budget helper (APIReviewer-015).
 *
 * The LLM-trace store holds higher-PII, shorter-retention data than the kernel
 * audit ledger, and `LLMTrace.completion` / `logprobs` / `toolCallsRaw` are
 * unbounded by type. Adopters with a storage budget run traces through
 * `boundLLMTrace()` before `emitLLMTrace` to cap those fields and stamp the
 * schema version. Sampling (drop a fraction of traces) stays an adopter policy
 * at the emit site — the helper bounds SIZE, not RATE.
 */
import type { LLMTrace } from "./ports/telemetry.js";

/** Current telemetry record schema version. Bump on a breaking shape change. */
export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export interface LLMTraceBudget {
  /** Max chars of `completion` to retain (default 4096). */
  readonly maxCompletionChars?: number;
  /** Max `logprobs` entries to retain (default 0 — drop by default). */
  readonly maxLogprobs?: number;
  /** Max `toolCallsRaw` entries to retain (default: keep all). */
  readonly maxToolCalls?: number;
}

/**
 * Return a copy of `trace` with size-bounded diagnostic fields and the current
 * `schemaVersion` stamped. Truncates `completion`, caps `logprobs` (dropped
 * entirely by default — it's the heaviest, rarely-needed field), and optionally
 * caps `toolCallsRaw`. Pure; never mutates the input.
 */
export function boundLLMTrace(
  trace: LLMTrace,
  budget: LLMTraceBudget = {},
): LLMTrace {
  const maxCompletion = budget.maxCompletionChars ?? 4096;
  const maxLogprobs = budget.maxLogprobs ?? 0;

  const completion =
    trace.completion.length > maxCompletion
      ? trace.completion.slice(0, maxCompletion)
      : trace.completion;

  const logprobs =
    trace.logprobs && maxLogprobs > 0
      ? trace.logprobs.slice(0, maxLogprobs)
      : undefined;

  const toolCallsRaw =
    trace.toolCallsRaw && budget.maxToolCalls !== undefined
      ? trace.toolCallsRaw.slice(0, budget.maxToolCalls)
      : trace.toolCallsRaw;

  // Exclude the diagnostic fields from the spread so a dropped field (e.g.
  // logprobs at the default maxLogprobs:0) is actually GONE, not carried over.
  const { logprobs: _lp, toolCallsRaw: _tc, ...rest } = trace;
  return {
    ...rest,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    completion,
    ...(logprobs !== undefined ? { logprobs } : {}),
    ...(toolCallsRaw !== undefined ? { toolCallsRaw } : {}),
  };
}

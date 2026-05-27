/**
 * @claustrum/conformance — public types.
 *
 * The runtime conformance suite reframes the cognitive-loop invariants
 * (PART I §"Invariants — must always hold") as something adopters can
 * call against their own Conductor at boot or in CI:
 *
 *   CC-001  tool-capability-indirection  — LLM-facing tools are exactly
 *                                          `[express_intent]`; internal
 *                                          ids never leak.
 *   CC-002  execute-triggers-one-tool    — EXECUTE → exactly one tool
 *                                          invocation; non-EXECUTE → 0.
 *   CC-003  prompt-manifest-in-trace     — every LLM trace carries a
 *                                          non-empty fragment manifest.
 *   CC-004  refuse-renders-user-text     — every REFUSE renders to
 *                                          non-empty user-facing text.
 *   CC-005  memory-recent-actions-via-api — MemoryPort.recentActions
 *                                          routes through Adjudicator;
 *                                          no raw "intent_audit" SQL.
 *   CC-006  few-shot-regression          — fixtures/*.json drift detector.
 *
 * Unlike `@adjudicate/conformance` (sync; Pack-shaped input), this runner
 * is **async** — checks invoke the Conductor's cognitive loop end-to-end,
 * which is itself async (memory.recall, planner.propose, etc.).
 *
 * The harness is intentionally side-effect-free: checks construct
 * scratch Conductors when they need to instrument ports (e.g., CC-002
 * uses a counting ToolPack) but never write audit records.
 */

import type { Conductor } from "@claustrum/core";

/**
 * One conformance invariant. Authored once in `src/checks/<id>.ts`;
 * collected into the framework default set as `DEFAULT_CHECKS`. Adopters
 * who want to register additional runtime-specific invariants can pass
 * `{ checks: [...] }` to `runConformance()`.
 *
 * A check returns a `Promise<ConformanceResult>`. It MUST NOT reject —
 * bugs in a check should still produce a clean `passed: false` with a
 * useful `details` string. The harness wraps every check in a try/catch
 * as defence in depth.
 */
export interface ConformanceCheck {
  /**
   * Stable, machine-readable identifier. Convention: `"CC-NNN"`
   * (Claustrum Conformance, three-digit zero-padded). Audit dashboards
   * filter by this id; tooling can suppress a single check by id in CI
   * without editing the harness.
   */
  readonly id: string;
  /** Human-readable name (no markup). Used in `ConformanceReport`. */
  readonly name: string;
  /**
   * Run the invariant against `conductor`. Returns a result describing
   * whether the runtime satisfied the invariant. Must be deterministic —
   * same `(conductor, options)` MUST produce the same result on repeated
   * invocations when the conductor itself is deterministic. PRNG seeding
   * is mandatory; `Math.random()` is banned.
   */
  run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult>;
}

/**
 * Options governing `runConformance()`. All fields are optional with
 * documented defaults so the canonical adopter call site is just
 * `await runConformance(myConductor)`.
 */
export interface ConformanceOptions {
  /**
   * Number of seeded turns generated per fuzz-style check (CC-002, CC-006).
   * The deterministic LCG seed (`options.seed`) controls the sequence so
   * `sampling` does not introduce nondeterminism — increasing it just
   * extends the deterministic walk. Default: `100`.
   */
  readonly sampling?: number;
  /**
   * Seed for the LCG-based PRNG used by random-turn-generation checks.
   * Default: `42`. Adopters who want diversity across runs (e.g., nightly
   * CI that sweeps seeds) bump this value externally. **Same seed → same
   * turns → same results.** No part of the harness touches `Math.random()`.
   */
  readonly seed?: number;
  /**
   * Override the default check set. Useful for CI configurations that
   * want a subset or that want to register runtime-specific custom
   * invariants alongside the framework defaults. Defaults to
   * `DEFAULT_CHECKS`.
   */
  readonly checks?: ReadonlyArray<ConformanceCheck>;
  /**
   * Optional path to a directory of few-shot fixtures used by CC-006.
   * When unset, CC-006 uses the harness-shipped `fixtures/few-shots/`.
   */
  readonly fixturesDir?: string;
}

/**
 * Outcome of running one `ConformanceCheck`. `passed === false` carries
 * an operator-facing `details` string explaining why; `passed === true`
 * may also carry `details` (typically a sample-count confirmation).
 */
export interface ConformanceResult {
  readonly id: string;
  readonly name: string;
  readonly passed: boolean;
  /**
   * Free-form operator detail. On failure, this is the load-bearing
   * field — it should name the invariant, the input that violated it,
   * and the observed behaviour. On success, optional sample-count or
   * skipped-reason note.
   */
  readonly details?: string;
}

/**
 * Aggregate report from `runConformance()`. The `passed` flag is the
 * AND of every result's `passed`. `summary` is the count breakdown so
 * dashboards can render at a glance without iterating `results`.
 */
export interface ConformanceReport {
  readonly results: ReadonlyArray<ConformanceResult>;
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
}

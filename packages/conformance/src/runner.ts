/**
 * `runConformance(conductor, options) → Promise<ConformanceReport>`.
 *
 * The single public entry point of `@claustrum/conformance`. Adopters
 * who want to verify their Conductor against the runtime invariant suite
 * call this — at boot time, in CI, or both:
 *
 * ```ts
 * import { runConformance } from "@claustrum/conformance";
 * import { conductor } from "./bootstrap.js";
 *
 * const report = await runConformance(conductor);
 * if (!report.passed) {
 *   for (const r of report.results) {
 *     if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`);
 *   }
 *   process.exit(1);
 * }
 * ```
 *
 * Determinism: same `(conductor, options)` SHOULD produce a byte-identical
 * `ConformanceReport` when the conductor itself is deterministic. The
 * harness threads a seeded LCG through every check that samples turns;
 * `Math.random()` is banned in this package. Adopters whose conductor
 * wires non-deterministic providers (e.g., a real LLM) get repeatable
 * shape but not byte-identical strings.
 *
 * Defence in depth: every check is invoked inside a try/catch so a bug
 * in one check cannot crash the harness — the failing check produces a
 * `passed: false` with the thrown message in `details`, and the rest
 * of the suite still runs.
 */

import type { Conductor } from "@claustrum/core";
import { DEFAULT_CHECKS } from "./checks.js";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceReport,
  ConformanceResult,
} from "./types.js";

export async function runConformance(
  conductor: Conductor,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const checks: ReadonlyArray<ConformanceCheck> =
    options.checks ?? DEFAULT_CHECKS;
  const results: ConformanceResult[] = [];

  for (const check of checks) {
    let result: ConformanceResult;
    try {
      result = await check.run(conductor, options);
    } catch (err) {
      // Defence in depth — a check that throws still produces a clean
      // failed result instead of bringing down the harness.
      result = {
        id: check.id,
        name: check.name,
        passed: false,
        details: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    results.push(result);
  }

  let passedCount = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.passed) passedCount++;
    else failedCount++;
  }

  return {
    results,
    passed: failedCount === 0,
    summary: {
      total: results.length,
      passed: passedCount,
      failed: failedCount,
    },
  };
}

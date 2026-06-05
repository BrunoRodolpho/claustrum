/**
 * @claustrum/conformance — runtime invariant suite for adopters.
 *
 * Reframes the cognitive-loop invariants (tool-capability indirection,
 * single-EXECUTE per turn, prompt manifest in trace, REFUSE renders text,
 * memory routes via Adjudicator, few-shot regression) as a one-shot
 * check adopters can call against their own Conductor:
 *
 * ```ts
 * import { runConformance } from "@claustrum/conformance";
 * import { conductor } from "./bootstrap.js";
 *
 * const report = await runConformance(conductor);
 * if (!report.passed) process.exit(1);
 * ```
 *
 * The harness is deterministic — same `(conductor, options)` produces
 * the same `ConformanceReport` shape on repeated invocations when the
 * conductor itself is deterministic. No `Math.random()`, no
 * `Date.now()` within the check logic; turn sampling is driven by a
 * seeded LCG threaded through every check.
 *
 * The harness is non-destructive: it wraps the conductor's ports
 * (telemetry, explainer, adjudicator, tools) for the duration of each
 * check and restores them on exit via try/finally so adopter state
 * is byte-identical after the report is returned.
 */

export { runConformance } from "./runner.js";
export { DEFAULT_CHECKS } from "./default-checks.js";
export {
  type ConformanceCheck,
  type ConformanceOptions,
  type ConformanceReport,
  type ConformanceResult,
} from "./types.js";

// Individual checks exported by id so adopters who want to assemble a
// partial set (e.g., skip CC-006 because no fixtures yet) can pass
// `{ checks: [...] }`.
export { toolCapabilityIndirectionCheck } from "./checks/tool-capability-indirection.js";
export { executeTriggersOneToolCheck } from "./checks/execute-triggers-one-tool.js";
export { promptManifestInTraceCheck } from "./checks/prompt-manifest-in-trace.js";
export { refuseRendersUserTextCheck } from "./checks/refuse-renders-user-text.js";
export { memoryRecentActionsViaApiCheck } from "./checks/memory-recent-actions-via-api.js";
export { fewShotRegressionCheck } from "./checks/few-shot-regression.js";

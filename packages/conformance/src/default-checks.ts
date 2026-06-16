/**
 * Default check set assembled in stable id-order. The order matters:
 * `runConformance()` invokes checks in this order, and the resulting
 * `ConformanceReport.results` reflects it. Tooling that pretty-prints
 * the report (CLI logs, the future Operator Console panel) relies on
 * this for a consistent display.
 *
 * Stable order also keeps `passed: true` reports byte-identical across
 * runs — important for snapshot tests in adopter projects.
 */

import { executeTriggersOneToolCheck } from "./checks/execute-triggers-one-tool.js";
import { fewShotRegressionCheck } from "./checks/few-shot-regression.js";
import { memoryRecentActionsViaApiCheck } from "./checks/memory-recent-actions-via-api.js";
import { promptManifestInTraceCheck } from "./checks/prompt-manifest-in-trace.js";
import { refuseRendersUserTextCheck } from "./checks/refuse-renders-user-text.js";
import { responderRespectsDecisionCheck } from "./checks/responder-respects-decision.js";
import { toolCapabilityIndirectionCheck } from "./checks/tool-capability-indirection.js";
import type { ConformanceCheck } from "./types.js";

export const DEFAULT_CHECKS: ReadonlyArray<ConformanceCheck> = [
  toolCapabilityIndirectionCheck,
  executeTriggersOneToolCheck,
  promptManifestInTraceCheck,
  refuseRendersUserTextCheck,
  memoryRecentActionsViaApiCheck,
  fewShotRegressionCheck,
  responderRespectsDecisionCheck,
];

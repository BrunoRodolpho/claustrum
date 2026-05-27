/**
 * @claustrum/cli — programmatic re-export of the command runners so other
 * packages or test harnesses can invoke them without spawning a child
 * process.
 */

export { runInit, type InitOptions, type InitResult } from "./commands/init.js";
export {
  runReplay,
  type ReplayOptions,
  type ReplayResult,
} from "./commands/replay.js";
export {
  runConformanceCommand,
  type ConformanceCommandOptions,
  type ConformanceCommandResult,
} from "./commands/conformance.js";
export {
  loadConductorFactory,
  type ConductorFactory,
  type LoadedConductorFactory,
} from "./lib/load-conductor.js";
export {
  renderTemplate,
  type RenderResult,
  type RenderTemplateOptions,
  type TemplateVars,
} from "./lib/template.js";

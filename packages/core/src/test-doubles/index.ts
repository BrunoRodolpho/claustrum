/**
 * @claustrum/core/test-doubles — barrel.
 *
 * Exported under the `./test-doubles` subpath so adapter packages can:
 *   import { InMemoryModelProvider } from "@claustrum/core/test-doubles";
 *
 * without dragging the doubles into production bundles.
 */

export { InMemoryModelProvider } from "./in-memory-model-provider.js";
export {
  InMemoryMemoryProvider,
  type InMemoryMemoryProviderOptions,
} from "./in-memory-memory-provider.js";
export { InMemorySessionStore } from "./in-memory-session-store.js";
export { InMemorySessionLock } from "./in-memory-session-lock.js";
export { WebChannelStub } from "./web-channel-stub.js";
export { StubAdjudicator } from "./stub-adjudicator.js";
export {
  RecordingTelemetrySink,
  type RecordingTelemetrySinkOptions,
} from "./recording-telemetry-sink.js";
export { EmptyGroundingProvider } from "./empty-grounding-provider.js";
export {
  runModelProviderContract,
  type ContractOptions,
  type ContractTestSurface,
} from "./model-provider-contract.js";

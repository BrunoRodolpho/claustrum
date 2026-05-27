/**
 * @claustrum/core — the governance-native conversational runtime spine.
 *
 * Public barrel. Adapter packages and adopter apps import from here.
 * The `./test-doubles` subpath ships in-memory implementations for
 * property tests + contract harnesses.
 */

// ── Conductor + Capsule + cognitive loop ───────────────────────────────────
export {
  createConductor,
  type Conductor,
  type ConductorOptions,
  type OpenCapsuleInput,
} from "./conductor.js";
export type { Capsule, ChannelMap } from "./capsule.js";
export { handleTurn, type TurnResult } from "./handle-turn.js";

// ── Dispatch ───────────────────────────────────────────────────────────────
export { dispatchDecision, type DispatchResult } from "./execution/dispatch.js";

// ── Ports ──────────────────────────────────────────────────────────────────
export type {
  ModelProvider,
  CompletionRequest,
  Completion,
  CompletionChunk,
  CancellableStream,
  StopReason,
  CompletionErrorCode,
} from "./ports/model-provider.js";
export { CompletionError } from "./ports/model-provider.js";

export type {
  MemoryPort,
  MemorySnapshot,
  MemoryItem,
  TurnOutcome,
} from "./ports/memory.js";

export type {
  GroundingPort,
  GroundingProof,
  GroundingSource,
  GroundingSpec,
  RetrievedDocs,
  RetrievedDoc,
  Perception,
} from "./ports/grounding.js";

export type {
  ChannelDriver,
  ChannelMessage,
  RenderedResponse,
  SignedEnvelope,
  ChannelKind,
} from "./ports/channel.js";

export type { PlannerPort, Plan, CognitiveState } from "./ports/planner.js";
export type {
  ResponderPort,
  DraftResponse,
  OutputContext,
} from "./ports/responder.js";
export type { ExplainerPort } from "./ports/explainer.js";
export type { HandoffPort } from "./ports/handoff.js";
export type {
  SessionPort,
  Session,
  ParkedEnvelope,
  DeferredEnvelope,
  WorkingMemoryFrame,
  Goal,
} from "./ports/session.js";
export type {
  TelemetryPort,
  LLMTrace,
  TurnRecord,
  MemoryAccess,
} from "./ports/telemetry.js";
export type {
  Adjudicator,
  SystemState,
  PolicyBundle,
  OutcomeFilter,
  OutcomeRow,
  AuditVerification,
} from "./ports/adjudicator.js";
export type {
  FewShotIndex,
  FewShotExample,
  FewShotQuery,
  FewShotMessage,
} from "./ports/few-shot.js";
export type {
  TenantConfig,
  TenantResolver,
  TenantResolution,
} from "./ports/tenant.js";

// ── Tools ──────────────────────────────────────────────────────────────────
export type {
  ToolDefinition,
  CapabilityDescriptor,
  CapabilityId,
  IntentKind,
  Actor,
  ActorRole,
} from "./tools/types.js";
export { createToolRegistry, type ToolRegistry } from "./tools/registry.js";

// ── Prompting ──────────────────────────────────────────────────────────────
export {
  createFragmentRegistry,
  type FragmentRegistry,
  type PromptFragment,
  type PromptContext,
} from "./prompting/fragment-registry.js";
export {
  createPromptComposer,
  type PromptComposer,
  type ComposerOptions,
  type ComposedPrompt,
  type ComposedMessage,
  type TokenBudget,
} from "./prompting/synthesizer.js";

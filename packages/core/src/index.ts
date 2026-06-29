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
  defaultLockKey,
  sessionKeyAwareLockKey,
  type Conductor,
  type ConductorOptions,
  type LockKeyStrategy,
  type OpenCapsuleInput,
} from "./conductor.js";
export type { Capsule, ChannelMap } from "./capsule.js";
export { handleTurn, type TurnResult } from "./handle-turn.js";

// ── Dispatch ───────────────────────────────────────────────────────────────
export { dispatchDecision, type DispatchResult } from "./execution/dispatch.js";

// ── Retry / backoff (consumes CompletionError.retryAfterMs) ─────────────────
export {
  retryWithBackoff,
  computeRetryDelayMs,
  type RetryOptions,
} from "./execution/retry.js";

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
  ChannelArtifact,
  RecipientArtifact,
  ParkedMatch,
  UserResolution,
} from "./ports/channel.js";
export { isRecipientArtifact } from "./ports/channel.js";

export type {
  GatewayKeyProvider,
  GatewaySigningKey,
} from "./gateway-attestation.js";
export {
  resolveGatewaySigningKey,
  verifyGatewayAttestation,
} from "./gateway-attestation.js";

export type {
  PlannerPort,
  Plan,
  CognitiveState,
  TokenUsage,
} from "./ports/planner.js";
export type {
  ResolverPort,
  ResolvedEnvelope,
  ResolverInput,
} from "./ports/resolver.js";
export type {
  InvestigatorPort,
  InvestigateInput,
} from "./ports/investigator.js";
export type {
  ClaimPlannerPort,
  ClaimPlannerInput,
} from "./ports/claim-planner.js";
export {
  runInvestigate,
  runClaimsValidate,
} from "./claims-loop/index.js";
export type {
  ClaimsRendererPort,
  ClaimsRenderResult,
} from "./ports/claims-renderer.js";
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
export type { SessionLock, SessionLockHandle } from "./ports/session-lock.js";
export type {
  TelemetryPort,
  LLMTrace,
  TurnRecord,
  MemoryAccess,
} from "./ports/telemetry.js";
export {
  TELEMETRY_SCHEMA_VERSION,
  boundLLMTrace,
  type LLMTraceBudget,
} from "./telemetry-bounds.js";
export type {
  Adjudicator,
  SystemState,
  PolicyBundle,
  OutcomeFilter,
  OutcomeRow,
  AuditVerification,
  ConfirmationReceipt,
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
export { asCapability, isWellFormedCapability } from "./tools/types.js";
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

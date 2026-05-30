/**
 * Capsule — the per-turn cognitive context handle.
 *
 * CRITICAL NAMING NOTE — Capsule is NOT `RuntimeContext`. The kernel
 * (@adjudicate/core) exports `RuntimeContext` which is the per-tenant
 * mutable-singleton container (kill switch, metrics sinks, etc.).
 * Capsule is the per-TURN context — short-lived, scoped to one
 * conversational turn, contains every port the cognitive loop needs.
 *
 * Conflating the two is a category error. Reviewers MUST surface
 * `ctx.adjudicate(...)` calls and confirm `ctx` is a Capsule (runtime)
 * vs `RuntimeContext` (kernel).
 *
 * The Capsule is constructed by `Conductor.openCapsule` and discarded
 * by `Conductor.closeCapsule` after the turn.
 */

import type { Decision, IntentEnvelope } from "@adjudicate/core";
import type {
  Adjudicator,
  PolicyBundle,
  SystemState,
} from "./ports/adjudicator.js";
import type { ChannelDriver, ChannelKind } from "./ports/channel.js";
import type { ExplainerPort } from "./ports/explainer.js";
import type { GroundingPort } from "./ports/grounding.js";
import type { HandoffPort } from "./ports/handoff.js";
import type { MemoryPort } from "./ports/memory.js";
import type { PlannerPort } from "./ports/planner.js";
import type { ResponderPort } from "./ports/responder.js";
import type { Session, SessionPort } from "./ports/session.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import type { TenantConfig } from "./ports/tenant.js";
import type { Actor } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * A per-channel mapping of drivers, keyed by ChannelKind. Available on
 * the Capsule under `channels`. The runtime's `perceive` phase picks
 * the driver matching the inbound channel.
 *
 * Typed as `Partial<…>` so that TypeScript flags missing-key access at
 * sites that index by a `ChannelKind` — the result is `ChannelDriver |
 * undefined` and callers must guard before use.  Using the closed `ChannelKind`
 * union (rather than `string`) prevents arbitrary string keys and preserves
 * the exhaustive union check when new channel kinds are added.
 */
export type ChannelMap = Partial<Readonly<Record<ChannelKind, ChannelDriver>>>;

export interface Capsule {
  // ── Identity ──────────────────────────────────────────────────────────────
  readonly tenant: TenantConfig;
  readonly customerId: string;
  readonly actor: Actor;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;

  // ── Where I am ────────────────────────────────────────────────────────────
  readonly channel: ChannelKind;
  readonly locale: string;
  readonly environment: "dev" | "staging" | "prod";

  // ── Ports (everything the cognitive loop calls) ───────────────────────────
  readonly memory: MemoryPort;
  readonly grounding: GroundingPort;
  readonly planner: PlannerPort;
  readonly tools: ToolRegistry;
  readonly channels: ChannelMap;
  readonly responder: ResponderPort;
  readonly adjudicator: Adjudicator;
  readonly explainer: ExplainerPort;
  readonly handoff: HandoffPort;
  readonly telemetry: TelemetryPort;
  readonly session: SessionPort;
  /**
   * The session snapshot loaded for THIS turn, bound at openCapsule time.
   * This is the only handle to "the session this turn is acting on" — the
   * SessionPort has no process-global `current()` accessor (its removal is
   * the RC-R3 footgun fix: a "most recently loaded" accessor returned the
   * wrong session under concurrent turns for different customers). Session-
   * scoped port ops (`parkPendingConfirmation`/`parkDeferred`/`unpark`) are
   * called with `loadedSession.id`. The Conductor holds a per-session lock
   * for the turn's lifetime, so this snapshot is stable.
   */
  readonly loadedSession: Session;

  // ── Kernel-bound (resolved per turn by TenantResolver) ────────────────────
  readonly state: SystemState;
  readonly policy: PolicyBundle;

  // ── Convenience ───────────────────────────────────────────────────────────
  /**
   * Forward to `adjudicator.adjudicate(envelope, state, policy)` with
   * the capsule's current state/policy pre-bound. The cognitive loop
   * calls this exactly once per turn (except for plans of length > 1,
   * which use `adjudicatePlan`).
   */
  adjudicate(envelope: IntentEnvelope): Promise<Decision>;
  adjudicatePlan(envelopes: ReadonlyArray<IntentEnvelope>): Promise<Decision>;
}

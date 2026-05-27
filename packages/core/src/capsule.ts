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
import type { SessionPort } from "./ports/session.js";
import type { TelemetryPort } from "./ports/telemetry.js";
import type { TenantConfig } from "./ports/tenant.js";
import type { Actor } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";

/**
 * A per-channel mapping of drivers, keyed by ChannelKind. Available on
 * the Capsule under `channels`. The runtime's `perceive` phase picks
 * the driver matching the inbound channel.
 */
export type ChannelMap = Readonly<Record<string, ChannelDriver>>;

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

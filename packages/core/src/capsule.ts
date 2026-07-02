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

import type {
  ClaimsKernelDeps,
  Decision,
  EvidenceLedger,
  IntentEnvelope,
} from "@adjudicate/core";
import type {
  Adjudicator,
  ConfirmationReceipt,
  PolicyBundle,
  SystemState,
} from "./ports/adjudicator.js";
import type { ChannelDriver, ChannelKind } from "./ports/channel.js";
import type { ClaimPlannerPort } from "./ports/claim-planner.js";
import type {
  ActiveResourceRef,
  ClaimsRendererPort,
} from "./ports/claims-renderer.js";
import type { ExplainerPort } from "./ports/explainer.js";
import type { GroundingPort } from "./ports/grounding.js";
import type { HandoffPort } from "./ports/handoff.js";
import type { InvestigatorPort } from "./ports/investigator.js";
import type { MemoryPort } from "./ports/memory.js";
import type { PlannerPort } from "./ports/planner.js";
import type { ResolverPort } from "./ports/resolver.js";
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

/**
 * Per-turn Claims-Kernel deps builder (SDD §F / §Q.3; the W5b conductor seam).
 *
 * The published `ClaimsKernelDeps` threaded onto the Capsule is a PROCESS-WIDE
 * value, but two of its soundness capabilities are genuinely PER-TURN: `owns`
 * (the owner-scoped resource set this turn's authenticated customer actually
 * read) and `outcomeConfirmed`. The conductor's existing per-turn rebuild only
 * refreshes `now`; this seam lets an adopter rebuild the FULL deps for the turn,
 * derived ONLY from the threaded read-only Evidence Ledger + the AUTHENTICATED
 * `customerId` — NEVER a session/model-supplied id (IDOR stays closed: "no owner"
 * ≠ "any owner"). It receives `base` (the deps with the per-turn `now` already
 * floored — see CLAIMS-VALIDATE) and returns the reconciled deps.
 *
 * PURE at the kernel boundary: it returns plain `ClaimsKernelDeps` (the `owns` /
 * `outcomeConfirmed` predicates + numeric `now`), so the kernel still composes a
 * pure value. Absent → the static `base` is used (byte-identical to today).
 */
export type ClaimsKernelDepsForTurn = (args: {
  /** This turn's threaded, read-only Evidence Ledger (INVESTIGATE output). */
  readonly ledger: EvidenceLedger;
  /** The AUTHENTICATED customer for this turn (the conductor identity). */
  readonly customerId: string;
  /** The process-wide deps with the per-turn `now` already floored. */
  readonly base: ClaimsKernelDeps;
}) => ClaimsKernelDeps;

/**
 * Per-turn active-resources deriver (the #8 decomposer ownership-signal seam).
 *
 * The §O#15 required-claim decomposer (adopter-side, inside the claims
 * renderer) needs to know WHICH owner-scoped resources are active THIS turn
 * (e.g. the customer's in-flight order / pending payment) to demand ownership
 * companions for them. Like {@link ClaimsKernelDepsForTurn}, the signal must
 * derive ONLY from the threaded read-only Evidence Ledger + the AUTHENTICATED
 * `customerId` — NEVER a session/model-supplied id (IDOR stays closed: "no
 * owner" ≠ "any owner"). `handleTurn` invokes it at RENDER-FROM-CLAIMS and
 * threads the result as `ClaimsRenderContext.activeResources`.
 *
 * PURE: plain data in, plain refs out (no clock/RNG/IO). Absent → the render
 * context carries no `activeResources` (byte-identical to today).
 */
export type ActiveResourcesForTurn = (args: {
  /** This turn's threaded, read-only Evidence Ledger (INVESTIGATE output). */
  readonly ledger: EvidenceLedger;
  /** The AUTHENTICATED customer for this turn (the conductor identity). */
  readonly customerId: string;
}) => readonly ActiveResourceRef[];

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
  /**
   * Optional pre-adjudication resolve stage. When wired, `handleTurn` runs it
   * between PLAN and SUBMIT to turn (possibly natural-language) envelopes into
   * resolved envelopes + per-envelope assembled state. Absent → the plan is
   * adjudicated as-is against `state`.
   */
  readonly resolver?: ResolverPort;
  /**
   * Optional INVESTIGATE stage (SDD §M / §Q.6; v1.1 §7; Inv 7). When wired,
   * `handleTurn` runs it after RESOLVE to populate THE per-turn Evidence Ledger
   * from this turn's resolved reads/context — the ledger is then threaded into
   * CLAIMS-VALIDATE. Absent → no claim pipeline runs (legacy loop unchanged).
   * The Ledger is structural to the loop, NOT embedded in the responder (§M).
   */
  readonly investigator?: InvestigatorPort;
  /**
   * Optional candidate-claim source for the CLAIMS-VALIDATE stage (SDD §M /
   * §Q.6; v1.1 §8). When wired (with `investigator` + `claimsKernel`), the
   * planner's typed candidate claims are run through the published Claims Kernel
   * (P1 ∘ P2) against the threaded ledger. The claim-aware planner that
   * constrains generation over the registry enum lands DOWNSTREAM (ibatexas).
   */
  readonly claimPlanner?: ClaimPlannerPort;
  /**
   * The injected capabilities the published Claims Kernel composes (SDD §F): the
   * Q3 soundness deps (`owns` / `outcomeConfirmed` / `now`) and the optional Q4
   * same-subject consistency table. Repo-specific (ownership model,
   * action-outcome wiring); claustrum threads them straight through and holds no
   * policy of its own. Required (with `claimPlanner`) for CLAIMS-VALIDATE to run.
   */
  readonly claimsKernel?: ClaimsKernelDeps;
  /**
   * Optional per-turn Claims-Kernel deps builder (the W5b conductor seam — see
   * {@link ClaimsKernelDepsForTurn}). When wired, CLAIMS-VALIDATE invokes it
   * post-INVESTIGATE / pre-kernel to rebuild `owns` / `outcomeConfirmed` from
   * THIS turn's owner-scoped ledger reads + the authenticated `customerId`, so an
   * owner-scoped ORDER/PAYMENT claim can VALIDATE for the legit owner (the
   * process-wide `claimsKernel` boot-empty owner set fails it shut otherwise).
   * Absent → the static `claimsKernel` deps are used (byte-identical).
   */
  readonly claimsKernelDepsForTurn?: ClaimsKernelDepsForTurn;
  /**
   * Optional render-from-claims seam (SDD §B / §Q.7). When wired AND
   * CLAIMS-VALIDATE produced a result, `handleTurn` renders the reply TEXT
   * deterministically from the validated claims (the "claims-not-prose" thesis),
   * superseding the model draft's text. Absent → the model-responder reply
   * (byte-identical). The deterministic renderer lives DOWNSTREAM (ibatexas).
   */
  readonly claimsRenderer?: ClaimsRendererPort;
  /**
   * Optional per-turn active-resources deriver (the #8 decomposer
   * ownership-signal seam — see {@link ActiveResourcesForTurn}). When wired AND
   * this turn produced an Evidence Ledger, RENDER-FROM-CLAIMS threads its
   * result to the renderer as `ClaimsRenderContext.activeResources`. Absent →
   * the render context carries no active-resource signal (byte-identical).
   */
  readonly activeResourcesForTurn?: ActiveResourcesForTurn;
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
   *
   * `stateOverride` (resolve-stage): the per-envelope `SystemState` the resolver
   * assembled for this envelope. When provided it supersedes the turn's
   * `resolution.state`; omitted → `resolution.state` is used (legacy behavior).
   */
  adjudicate(
    envelope: IntentEnvelope,
    stateOverride?: SystemState,
  ): Promise<Decision>;
  adjudicatePlan(
    envelopes: ReadonlyArray<IntentEnvelope>,
    perEnvelopeStates?: ReadonlyArray<SystemState>,
  ): Promise<Decision>;

  /**
   * Forward to `adjudicator.resume(envelope, state, policy, receipt)` with the
   * capsule's current (fresh, this-turn) state/policy pre-bound — so a resumed
   * confirmation is re-adjudicated against the state it must still be safe
   * against (money-safety). Present only when the adjudicator implements the
   * optional `resume` verb; the resume branch in `handleTurn` guards on it and
   * degrades to the normal loop when absent. The cognitive loop calls this in
   * place of `adjudicate` when an inbound reply resumes a parked envelope.
   */
  resume?(
    envelope: IntentEnvelope,
    receipt?: ConfirmationReceipt,
  ): Promise<Decision>;
}

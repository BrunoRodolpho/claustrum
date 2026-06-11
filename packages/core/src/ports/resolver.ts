/**
 * ResolverPort — OPTIONAL pre-adjudication resolve stage.
 *
 * Sits between PLAN and SUBMIT in the cognitive loop (`handleTurn`). It turns the
 * planner's proposed envelopes — whose payloads may carry unresolved, natural-
 * language references (e.g. `{ item: "linguiça" }`, "cancel my last order") — into
 * RESOLVED envelopes (concrete ids) plus a per-envelope assembled `SystemState`,
 * BEFORE the kernel adjudicates. This lets domain guards evaluate against real
 * entity state (order total, payment status, reservation slot, …) instead of a
 * stub, and ensures the resolved envelope is the one that gets adjudicated,
 * dispatched, AND audited (audited == executed).
 *
 * Contract:
 *  - READ-ONLY: resolution loads/queries; it MUST NOT mutate.
 *  - Returns exactly ONE entry per input envelope, order-aligned with
 *    `plan.envelopes`.
 *  - Each returned `envelope` MUST be rebuilt via `buildEnvelope` (so the kernel's
 *    `intentHash` re-derivation passes); never mutate the input envelope in place.
 *  - `state` is the per-envelope `SystemState` the kernel will adjudicate this
 *    envelope against. When `undefined`, the loop falls back to the turn's
 *    `resolution.state` (from the `TenantResolver`).
 *  - Unresolvable or cross-principal references SHOULD yield a `state` whose `ctx`
 *    fields are null/empty so domain guards REFUSE cleanly (never panic).
 *
 * OPTIONAL on the Capsule: when no resolver is wired, `handleTurn` adjudicates
 * `plan.envelopes` as-is against `resolution.state` (legacy behavior, unchanged).
 */

import type { IntentEnvelope } from "@adjudicate/core";
import type { SystemState } from "./adjudicator.js";
import type { ChannelKind } from "./channel.js";
import type { CognitiveState, Plan } from "./planner.js";

export interface ResolvedEnvelope {
  /** The resolved envelope, rebuilt via `buildEnvelope` (fresh canonical intentHash). */
  readonly envelope: IntentEnvelope;
  /**
   * Per-envelope `SystemState` the kernel adjudicates this envelope against.
   * `undefined` → the loop uses the turn's `resolution.state`.
   */
  readonly state?: SystemState;
}

export interface ResolverInput {
  readonly plan: Plan;
  readonly cognition: CognitiveState;
  /** The principal id for this turn — scopes every entity load (money-safety). */
  readonly customerId: string;
  readonly channel: ChannelKind;
}

export interface ResolverPort {
  resolve(input: ResolverInput): Promise<ReadonlyArray<ResolvedEnvelope>>;
}

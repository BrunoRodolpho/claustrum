/**
 * Adjudicator — the ONLY kernel-facing port the runtime uses.
 *
 * Defined here so the rest of @claustrum/* depends on this interface,
 * never directly on `@adjudicate/core`. Adapters (the production
 * `AdjudicateCoreAdjudicator` in the adopter app, plus `StubAdjudicator`
 * in test-doubles) provide implementations.
 *
 * The runtime imports `IntentEnvelope`, `Decision`, `AuditRecord`,
 * `Refusal`, etc. from `@adjudicate/core` as types ONLY. The Adjudicator
 * port is the runtime's sole kernel verb surface.
 *
 * `SystemState` and `PolicyBundle` are intentionally generic so the
 * runtime stays state-agnostic. The adopter parameterizes the kernel
 * shape at adjudicator construction.
 */

import type {
  AuditRecord,
  Decision,
  IntentEnvelope,
} from "@adjudicate/core";
// TODO: re-export from @adjudicate/core when public API exposes them
// (currently exported from @adjudicate/core/kernel as type parameters).
import type {
  DraftResponse,
  OutputContext,
} from "./responder.js";

/**
 * Opaque kernel-state placeholder. The kernel's `adjudicate<K, P, S>` is
 * generic over `S`; the runtime treats it as opaque — assembled by the
 * adopter's TenantResolver, passed through to the kernel, never inspected
 * by the cognitive loop.
 */
export type SystemState = unknown;

/**
 * Opaque PolicyBundle placeholder. Same reasoning as SystemState —
 * the runtime never reads the bundle; only the kernel does.
 */
export type PolicyBundle = unknown;

export interface OutcomeFilter {
  readonly customerId?: string;
  readonly intentKind?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly observed?: "succeeded" | "failed" | "withdrawn";
}

export interface OutcomeRow {
  readonly intentHash: string;
  readonly observed: "succeeded" | "failed" | "withdrawn";
  readonly at: string;
  readonly note?: string;
}

export type AuditVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface Adjudicator {
  /** Single-envelope adjudication — the hot path. */
  adjudicate(
    envelope: IntentEnvelope,
    state: SystemState,
    policy: PolicyBundle,
  ): Promise<Decision>;

  /** Multi-envelope (transactional) adjudication — atomic kill-all-or-execute-all. */
  adjudicatePlan(
    envelopes: ReadonlyArray<IntentEnvelope>,
    state: SystemState,
    policy: PolicyBundle,
  ): Promise<Decision>;

  /**
   * Optional semantic firewall over outbound responses. When wired,
   * the responder feeds drafts through this and aborts on REFUSE.
   */
  adjudicateOutput?(
    response: DraftResponse,
    context: OutputContext,
  ): Promise<Decision>;

  // ── Read APIs (the inverse contract) ──────────────────────────────────────

  /** Memory's operational-recall path. NEVER queried via raw SQL. */
  replayEnvelopesByCustomerId(
    customerId: string,
    since?: Date,
  ): Promise<ReadonlyArray<AuditRecord>>;

  streamAuditByIntentHashPrefix(prefix: string): AsyncIterable<AuditRecord>;

  getOutcomes(filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>>;

  verifyAuditRecord(record: AuditRecord): AuditVerification;
}

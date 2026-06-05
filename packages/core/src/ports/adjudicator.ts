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
  /**
   * Tenant scope (APIReviewer-001). Optional: single-tenant deployments omit it
   * (no cross-tenant rows exist); a multi-tenant caller sets it so an outcome read
   * cannot return rows from another tenant. The adopter's adjudicator threads this
   * into the audit query when its store is tenant-partitioned.
   */
  readonly tenantId?: string;
  readonly intentKind?: string;
  /** ISO 8601 timestamp string (e.g. "2024-01-01T00:00:00.000Z"). */
  readonly since?: string;
  /** ISO 8601 timestamp string (e.g. "2024-12-31T23:59:59.999Z"). */
  readonly until?: string;
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

/**
 * Receipt that the user affirmatively confirmed a previously-parked
 * REQUEST_CONFIRMATION envelope. Passed to {@link Adjudicator.resume}; the
 * adopter's adjudicator maps it onto the kernel's confirmation-receipt
 * mechanism so a re-adjudication that returns REQUEST_CONFIRMATION is
 * substituted with EXECUTE — but ONLY after the kernel's state/taint/auth
 * guards re-run against the (fresh) state. A state change that flips the
 * answer (REFUSE/DEFER/REWRITE/ESCALATE) is returned unchanged, never
 * overridden. The threshold-style "ask the user first" step is the only thing
 * the receipt satisfies.
 *
 * The caller owns the receipt's integrity — it represents an actual user
 * affirmation (e.g. a matched reply against a single-use confirmation token).
 */
export interface ConfirmationReceipt {
  /** intentHash of the parked envelope being confirmed. */
  readonly intentHash: string;
  /** ISO-8601 wall-clock of the user's confirmation. */
  readonly at: string;
  /**
   * Optional ISO-8601 `at` of the original REQUEST_CONFIRMATION audit row, so
   * the resumed EXECUTE record's supersession link points at the predecessor
   * row's timestamp. Omit to fall back to `at`.
   */
  readonly originalAt?: string;
  /**
   * Optional opaque single-use token from the confirmation store, recorded in
   * the supersession link for a forensic trail. The kernel does not verify it
   * (the adapter took the token before issuing this receipt).
   */
  readonly token?: string;
}

export interface Adjudicator {
  /** Single-envelope adjudication — the hot path. */
  adjudicate(
    envelope: IntentEnvelope,
    state: SystemState,
    policy: PolicyBundle,
  ): Promise<Decision>;

  /**
   * Resume a parked envelope by RE-ADJUDICATING it (never dispatch-on-confirm).
   *
   * This is the load-bearing audit invariant for long-lived confirmation /
   * deferral resumption: a resumed EXECUTE side-effect MUST be backed by a
   * fresh audited Decision. The adopter's implementation re-runs the envelope
   * through the audited kernel against the *current* state (so a stale-state
   * confirmation cannot license a now-unsafe mutation) and emits exactly one
   * AuditRecord BEFORE any dispatch.
   *
   * When `receipt` is supplied and the kernel returns REQUEST_CONFIRMATION for
   * the matching intentHash, the kernel substitutes EXECUTE (the "ask first"
   * threshold is satisfied) with a `confirmation_resolved` supersession link.
   * When `receipt` is omitted (e.g. a deferred envelope whose condition is now
   * met), it is a plain re-adjudication — EXECUTE only if the guards naturally
   * pass against fresh state.
   *
   * OPTIONAL on the port (like {@link adjudicateOutput}): adjudicators that do
   * not wire the kernel confirmation-receipt path omit it, and the runtime's
   * resume branch degrades safely to the normal loop (no dispatch-on-confirm).
   */
  resume?(
    envelope: IntentEnvelope,
    state: SystemState,
    policy: PolicyBundle,
    receipt?: ConfirmationReceipt,
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

  /**
   * Memory's operational-recall path. NEVER queried via raw SQL.
   *
   * `tenantId` (APIReviewer-001) is an OPTIONAL tenant scope: single-tenant
   * deployments omit it; a multi-tenant caller passes it so recall cannot surface
   * another tenant's envelopes. Optional + trailing, so existing 2-arg callers and
   * 2-param implementations are unaffected (the adopter wires it into the audit
   * store query when that store is tenant-partitioned).
   */
  replayEnvelopesByCustomerId(
    customerId: string,
    since?: Date,
    tenantId?: string,
  ): Promise<ReadonlyArray<AuditRecord>>;

  /** Audit stream by intentHash prefix. `tenantId` is the optional tenant scope (APIReviewer-001). */
  streamAuditByIntentHashPrefix(
    prefix: string,
    tenantId?: string,
  ): AsyncIterable<AuditRecord>;

  getOutcomes(filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>>;

  verifyAuditRecord(record: AuditRecord): AuditVerification;
}

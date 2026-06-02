/**
 * StubAdjudicator — minimal Adjudicator that returns EXECUTE except
 * when `envelope.kind === "danger"`, in which case it REFUSEs.
 *
 * The stub records every call so property tests can assert
 * "adjudicate called exactly once per turn". `adjudicateOutput` is
 * intentionally NOT implemented (it's optional on the port).
 */

import type {
  AuditRecord,
  Decision,
  IntentEnvelope,
} from "@adjudicate/core";
import type {
  Adjudicator,
  AuditVerification,
  ConfirmationReceipt,
  OutcomeFilter,
  OutcomeRow,
  PolicyBundle,
  SystemState,
} from "../ports/adjudicator.js";

export class StubAdjudicator implements Adjudicator {
  public readonly adjudicateCalls: Array<{
    readonly envelope: IntentEnvelope;
    readonly at: string;
  }> = [];
  public readonly adjudicatePlanCalls: Array<{
    readonly envelopes: ReadonlyArray<IntentEnvelope>;
    readonly at: string;
  }> = [];
  /**
   * Every `resume` call, recorded so a test can assert the loop RE-ADJUDICATED
   * a parked envelope (vs. the audit-invariant violation of dispatching it
   * directly on confirm). `receipt` is captured to prove the confirmation
   * receipt was threaded through.
   */
  public readonly resumeCalls: Array<{
    readonly envelope: IntentEnvelope;
    readonly receipt: ConfirmationReceipt | undefined;
    readonly at: string;
  }> = [];

  async adjudicate(
    envelope: IntentEnvelope,
    _state: SystemState,
    _policy: PolicyBundle,
  ): Promise<Decision> {
    void _state;
    void _policy;
    this.adjudicateCalls.push({
      envelope,
      at: new Date().toISOString(),
    });
    if (envelope.kind === "danger") {
      return {
        kind: "REFUSE",
        refusal: {
          kind: "SECURITY",
          code: "stub.danger",
          userFacing: "Não posso fazer isso.",
        },
        basis: [],
      };
    }
    return { kind: "EXECUTE", basis: [] };
  }

  async adjudicatePlan(
    envelopes: ReadonlyArray<IntentEnvelope>,
    _state: SystemState,
    _policy: PolicyBundle,
  ): Promise<Decision> {
    void _state;
    void _policy;
    this.adjudicatePlanCalls.push({
      envelopes,
      at: new Date().toISOString(),
    });
    if (envelopes.some((e) => e.kind === "danger")) {
      return {
        kind: "REFUSE",
        refusal: {
          kind: "SECURITY",
          code: "stub.plan.danger",
          userFacing: "Não posso fazer isso.",
        },
        basis: [],
      };
    }
    return { kind: "EXECUTE", basis: [] };
  }

  /**
   * Re-adjudicate a parked envelope. Mirrors `adjudicate`'s kind-based verdict
   * (`danger` → REFUSE, else EXECUTE) so a money-safety test can model "state
   * changed at confirm time → REFUSE → no dispatch" by resuming a `danger`
   * envelope. The receipt is recorded but does not alter the stub's verdict
   * (the real kernel's REQUEST_CONFIRMATION→EXECUTE flip is exercised against
   * the production `buildAdjudicator` + a capturing audit sink, not here).
   */
  async resume(
    envelope: IntentEnvelope,
    _state: SystemState,
    _policy: PolicyBundle,
    receipt?: ConfirmationReceipt,
  ): Promise<Decision> {
    void _state;
    void _policy;
    this.resumeCalls.push({
      envelope,
      receipt,
      at: new Date().toISOString(),
    });
    if (envelope.kind === "danger") {
      return {
        kind: "REFUSE",
        refusal: {
          kind: "STATE",
          code: "stub.resume.state_changed",
          userFacing: "Não posso mais concluir isso.",
        },
        basis: [],
      };
    }
    return { kind: "EXECUTE", basis: [] };
  }

  async replayEnvelopesByCustomerId(): Promise<ReadonlyArray<AuditRecord>> {
    return [];
  }

  streamAuditByIntentHashPrefix(
    _prefix: string,
  ): AsyncIterable<AuditRecord> {
    void _prefix;
    // Empty stream by default. Returns an iterable whose iterator
    // immediately reports done — no allocations, no yields.
    return {
      [Symbol.asyncIterator](): AsyncIterator<AuditRecord> {
        return {
          async next(): Promise<IteratorResult<AuditRecord>> {
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async getOutcomes(_filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>> {
    void _filter;
    return [];
  }

  verifyAuditRecord(_record: AuditRecord): AuditVerification {
    void _record;
    return { ok: true };
  }
}

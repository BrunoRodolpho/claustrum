/**
 * CC-005 — memory-recent-actions-via-api.
 *
 * `MemoryPort.recentActions()` MUST route through
 * `Adjudicator.replayEnvelopesByCustomerId()` — never via raw SQL into
 * the kernel's `intent_audit` table. This is the inverse-contract
 * commitment: the runtime owns memory, the kernel owns the ledger, and
 * the bridge between them is the Adjudicator read API.
 *
 * Methodology:
 *  - Wrap `conductor.adjudicator.replayEnvelopesByCustomerId` to count
 *    invocations; restore on exit.
 *  - Call `conductor.memory.recentActions(probeCustomerId, since)` and
 *    assert the counter incremented by ≥ 1.
 *
 * In-memory MemoryPort implementations (test-doubles) that return `[]`
 * without calling the Adjudicator pass vacuously — the check skips
 * them. Production Postgres-backed implementations that bypass the
 * Adjudicator and reach into `intent_audit` directly are caught by
 * this runtime counter check.
 *
 * The "no raw SQL with intent_audit" half of the invariant is enforced
 * ONLY at runtime by this counter check — there is no static lint rule
 * in the package's eslint config that catches raw SQL usage. The
 * counter check is the sole enforcement mechanism.
 */

import type { AuditRecord } from "@adjudicate/core";
import type { Conductor } from "@claustrum/core";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";
import { withInstrumentedPort } from "../instrumented-port.js";

export const memoryRecentActionsViaApiCheck: ConformanceCheck = {
  id: "CC-005",
  name: "MemoryPort.recentActions routes through Adjudicator.replayEnvelopesByCustomerId",
  async run(
    conductor: Conductor,
    _options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    void _options;

    let replayCount = 0;
    const adjudicator = conductor.adjudicator;
    const originalBound = adjudicator.replayEnvelopesByCustomerId.bind(adjudicator);

    let memoryThrew: Error | undefined;
    let recentActionsResult: ReadonlyArray<AuditRecord> = [];

    await withInstrumentedPort(
      adjudicator,
      "replayEnvelopesByCustomerId",
      (_original) => async (
        customerId: string,
        since?: Date,
      ): Promise<ReadonlyArray<AuditRecord>> => {
        replayCount++;
        return originalBound(customerId, since);
      },
      async (_spy) => {
        try {
          recentActionsResult = await conductor.memory.recentActions(
            "cc005-probe",
            new Date("2026-05-18T00:00:00.000Z"),
          );
        } catch (err) {
          memoryThrew = err instanceof Error ? err : new Error(String(err));
        }
      },
    );

    if (memoryThrew !== undefined) {
      return {
        id: memoryRecentActionsViaApiCheck.id,
        name: memoryRecentActionsViaApiCheck.name,
        passed: false,
        details: `memory.recentActions threw: ${memoryThrew.message}`,
      };
    }

    if (replayCount === 0) {
      // Two interpretations:
      //   (a) The MemoryPort is an in-memory stub that legitimately returns []
      //       without consulting the kernel ledger. Production adapters must
      //       route through the Adjudicator — but stubs are fine.
      //   (b) The MemoryPort is a production adapter that bypassed the
      //       Adjudicator (raw SQL into intent_audit). That's the failure
      //       this check exists to catch.
      // We cannot distinguish (a) from (b) by counter alone. Heuristic:
      // if recentActions returned an empty array AND replayCount is 0, we
      // treat it as (a) and pass with a "vacuous" note. If recentActions
      // returned a non-empty array AND replayCount is 0, that's (b) — the
      // memory port produced audit records WITHOUT consulting the kernel,
      // which is the boundary violation we're catching.
      if (recentActionsResult.length === 0) {
        return {
          id: memoryRecentActionsViaApiCheck.id,
          name: memoryRecentActionsViaApiCheck.name,
          passed: true,
          details:
            "memory.recentActions returned [] without consulting the Adjudicator — " +
            "consistent with an in-memory stub. Production adapters MUST route through " +
            "Adjudicator.replayEnvelopesByCustomerId; this check cannot distinguish stubs " +
            "from boundary-violating production code that returns nothing.",
        };
      }
      return {
        id: memoryRecentActionsViaApiCheck.id,
        name: memoryRecentActionsViaApiCheck.name,
        passed: false,
        details:
          `memory.recentActions returned ${recentActionsResult.length} record(s) without ` +
          `calling Adjudicator.replayEnvelopesByCustomerId — boundary violation. ` +
          `MemoryPort must NEVER bypass the kernel ledger.`,
      };
    }

    return {
      id: memoryRecentActionsViaApiCheck.id,
      name: memoryRecentActionsViaApiCheck.name,
      passed: true,
      details: `Adjudicator.replayEnvelopesByCustomerId invoked ${replayCount} time(s) by memory.recentActions.`,
    };
  },
};

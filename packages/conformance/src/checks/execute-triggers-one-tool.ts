/**
 * CC-002 — execute-triggers-one-tool.
 *
 * For every turn whose final Decision is EXECUTE, exactly one tool
 * invocation MUST occur in the ACT phase. For REFUSE / DEFER /
 * REQUEST_CONFIRMATION / ESCALATE the count MUST be zero. (REWRITE
 * also counts as one invocation — the rewritten envelope is executed.)
 *
 * Methodology:
 *  - Wrap every registered tool's `.execute` with a counter (restored
 *    after the check via try/finally so adopter state is unchanged).
 *  - Run `handleTurn` against the conductor `sampling` times with
 *    deterministically-varying inbound text.
 *  - For each turn, snapshot the decision kind and the per-turn counter
 *    delta; assert the matrix above.
 *
 * Sampling: 100 turns by default. The kernel returns whichever Decision
 * its policy dictates — the check does not force a Decision distribution.
 * If the adopter's conductor only ever returns EXECUTE (e.g., test
 * doubles), the REFUSE branch is vacuously true.
 */

import { handleTurn, type Conductor, type OpenCapsuleInput } from "@claustrum/core";
import { lcg } from "../prng.js";
import type {
  ConformanceCheck,
  ConformanceOptions,
  ConformanceResult,
} from "../types.js";
import { withInstrumentedPort } from "../instrumented-port.js";

type ExecuteFn = (input: unknown, ctx: unknown) => Promise<unknown>;

export const executeTriggersOneToolCheck: ConformanceCheck = {
  id: "CC-002",
  name: "EXECUTE triggers exactly one tool invocation; non-EXECUTE triggers zero",
  async run(
    conductor: Conductor,
    options: ConformanceOptions,
  ): Promise<ConformanceResult> {
    const sampling = options.sampling ?? 100;
    const seed = options.seed ?? 42;
    const rng = lcg(seed);

    const tools = conductor.tools.list();
    if (tools.length === 0) {
      return {
        id: executeTriggersOneToolCheck.id,
        name: executeTriggersOneToolCheck.name,
        passed: true,
        details: "No tools registered; invariant vacuously holds.",
      };
    }

    // Wrap every tool's `.execute` to count invocations. withInstrumentedPort
    // guarantees restoration even if the body throws. Each tool is wrapped
    // independently; we nest the calls so each has its own finally-restore.
    let invocationCounter = 0;
    const failures: string[] = [];
    let executes = 0;
    let nonExecutes = 0;

    // Build a nested runner that wraps all tools via withInstrumentedPort and
    // runs the sampling loop as the innermost body.
    async function runWithAllToolsInstrumented(
      remainingTools: typeof tools,
    ): Promise<void> {
      if (remainingTools.length === 0) {
        // All tools are wrapped — run the sampling body.
        for (let i = 0; i < sampling; i++) {
          const ridx = Math.floor(rng() * 0xffffffff);
          const text = `conformance-turn-${i}-${ridx}`;
          const inboundProbe: OpenCapsuleInput = {
            channel: "web",
            customerId: `cc002-cust-${i % 7}`,
            inbound: {
              channel: "web",
              customerId: `cc002-cust-${i % 7}`,
              conversationId: `cc002-conv-${i % 7}`,
              text,
              receivedAt: "2026-05-18T00:00:00.000Z",
            },
          };

          const beforeCount = invocationCounter;
          let capsule;
          try {
            capsule = await conductor.openCapsule(inboundProbe);
          } catch (err) {
            failures.push(
              `turn ${i}: openCapsule threw: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }

          let result;
          try {
            result = await handleTurn(capsule, inboundProbe.inbound);
          } catch (err) {
            failures.push(
              `turn ${i}: handleTurn threw: ${err instanceof Error ? err.message : String(err)}`,
            );
            await conductor.closeCapsule(capsule);
            continue;
          }
          await conductor.closeCapsule(capsule);

          const delta = invocationCounter - beforeCount;
          const decisionKind = result.decision.kind;

          if (decisionKind === "EXECUTE" || decisionKind === "REWRITE") {
            executes++;
            if (delta !== 1) {
              failures.push(
                `turn ${i}: ${decisionKind} produced ${delta} tool invocations (expected 1)`,
              );
            }
          } else {
            nonExecutes++;
            if (delta !== 0) {
              failures.push(
                `turn ${i}: ${decisionKind} produced ${delta} tool invocations (expected 0)`,
              );
            }
          }

          // Cap collected failures so we don't blow the report.
          if (failures.length >= 10) break;
        }
        return;
      }

      // Instrument the head tool and recurse to instrument the rest.
      const [head, ...tail] = remainingTools;
      const mutableHead = head as unknown as { execute: ExecuteFn };
      await withInstrumentedPort(
        mutableHead,
        "execute",
        (original) => async (input: unknown, ctx: unknown): Promise<unknown> => {
          invocationCounter++;
          return (original as ExecuteFn)(input, ctx);
        },
        async (_spy) => {
          await runWithAllToolsInstrumented(tail);
        },
      );
    }

    await runWithAllToolsInstrumented(tools);

    if (failures.length > 0) {
      return {
        id: executeTriggersOneToolCheck.id,
        name: executeTriggersOneToolCheck.name,
        passed: false,
        details: `Tool-invocation count violated: ${failures.join("; ")}`,
      };
    }

    return {
      id: executeTriggersOneToolCheck.id,
      name: executeTriggersOneToolCheck.name,
      passed: true,
      details: `Verified ${executes} EXECUTE/REWRITE and ${nonExecutes} non-EXECUTE turn(s) across ${sampling} samples.`,
    };
  },
};

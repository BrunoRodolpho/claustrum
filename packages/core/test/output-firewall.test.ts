/**
 * OUTPUT FIREWALL (optional, F1) — contract tests.
 *
 * `handleTurn` step 6b gates the synthesized draft through the adopter's
 * `adjudicator.adjudicateOutput` when (a) the tenant flag
 * `enable_output_adjudication` is on AND (b) the optional port method is bound.
 *
 * Invariants under test:
 *  - OFF by default — the draft (text + artifacts) passes through untouched,
 *    even when `adjudicateOutput` is bound (the flag, not the binding, arms it).
 *  - EXECUTE verdict → draft passes unchanged.
 *  - REFUSE → text becomes the explainer-rendered refusal, and artifacts are
 *    DROPPED (fail-closed: a blocked turn must not leak via an artifact what it
 *    scrubbed from text).
 *  - A throw, or any non-EXECUTE/REFUSE verdict, → GENERIC_REFUSAL_TEXT and
 *    artifacts dropped (the un-vetted draft is NEVER emitted).
 *  - This is an OUTPUT verb: it does not call `adjudicate()`, so the
 *    once-per-turn invariant (Hard Rule #3) is unaffected.
 */

import { describe, it, expect } from "vitest";
import type { Decision } from "@adjudicate/core";
import {
  handleTurn,
  type Capsule,
  type PlannerPort,
  type ResponderPort,
} from "../src/index.js";
import { GENERIC_REFUSAL_TEXT } from "../src/execution/dispatch.js";
import {
  buildHarness,
  buildInbound,
  buildTestEnvelope,
  makeTool,
} from "./properties/harness.js";

const SECRET_TEXT = "secret-draft-carrying-PII";
const ARTIFACT = { kind: "image", url: "secret.png" } as const;
const REFUSAL_TEXT = "blocked-by-output-firewall";

// The firewall only reads `.kind` (and `.refusal` on REFUSE); construct minimal
// decisions and cast rather than depend on the kernel's Decision builder API.
const asDecision = (d: unknown): Decision => d as Decision;

async function runFirewall(opts: {
  readonly enabled: boolean;
  readonly output?: () => Promise<Decision>;
}) {
  const planner: PlannerPort = {
    async propose() {
      return {
        envelopes: [buildTestEnvelope({ kind: "test.kind", principal: "llm" })],
      };
    },
  };
  const responder: ResponderPort = {
    async respond() {
      return { text: SECRET_TEXT, artifacts: [{ ...ARTIFACT }] };
    },
  };
  const noopTool = makeTool({
    id: "noop.tool",
    capability: "test.kind",
    intentKind: "test.kind",
    execute: async () => ({ ok: true }),
  });
  const { capsule } = await buildHarness({ planner, responder, tools: [noopTool] });
  const fwCapsule: Capsule = opts.enabled
    ? {
        ...capsule,
        tenant: {
          ...capsule.tenant,
          flags: { enable_output_adjudication: true },
        },
      }
    : capsule;
  if (opts.output !== undefined) {
    fwCapsule.adjudicator.adjudicateOutput = opts.output;
  }
  return handleTurn(fwCapsule, buildInbound("hello"));
}

describe("output firewall (F1)", () => {
  it("is OFF by default — passes the draft through even when the port is bound", async () => {
    const result = await runFirewall({
      enabled: false,
      // Bound but must NOT be consulted (flag is off).
      output: async () =>
        asDecision({ kind: "REFUSE", refusal: { kind: "X", userFacing: REFUSAL_TEXT } }),
    });
    expect(result.response.text).toBe(SECRET_TEXT);
    expect(result.response.artifacts).toHaveLength(1);
  });

  it("ON + EXECUTE verdict → draft passes unchanged (text + artifacts)", async () => {
    const result = await runFirewall({
      enabled: true,
      output: async () => asDecision({ kind: "EXECUTE" }),
    });
    expect(result.response.text).toBe(SECRET_TEXT);
    expect(result.response.artifacts).toHaveLength(1);
  });

  it("ON but port unbound → passes through (binding required to arm)", async () => {
    const result = await runFirewall({ enabled: true });
    expect(result.response.text).toBe(SECRET_TEXT);
    expect(result.response.artifacts).toHaveLength(1);
  });

  it("ON + REFUSE → renders refusal text AND drops artifacts (fail-closed)", async () => {
    const result = await runFirewall({
      enabled: true,
      output: async () =>
        asDecision({ kind: "REFUSE", refusal: { kind: "PII_BLOCKED", userFacing: REFUSAL_TEXT } }),
    });
    expect(result.response.text).toBe(REFUSAL_TEXT);
    expect(result.response.text).not.toContain(SECRET_TEXT);
    expect(result.response.artifacts).toBeUndefined();
  });

  it("ON + throw → GENERIC_REFUSAL_TEXT and artifacts dropped (never leak the draft)", async () => {
    const result = await runFirewall({
      enabled: true,
      output: async () => {
        throw new Error("firewall boom");
      },
    });
    expect(result.response.text).toBe(GENERIC_REFUSAL_TEXT);
    expect(result.response.text).not.toContain(SECRET_TEXT);
    expect(result.response.artifacts).toBeUndefined();
  });

  it("ON + non-EXECUTE/REFUSE verdict (DEFER) → blocked fail-safe, artifacts dropped", async () => {
    const result = await runFirewall({
      enabled: true,
      output: async () => asDecision({ kind: "DEFER" }),
    });
    expect(result.response.text).toBe(GENERIC_REFUSAL_TEXT);
    expect(result.response.artifacts).toBeUndefined();
  });
});

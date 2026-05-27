/**
 * `claustrum conformance` — thin wrapper around `runConformance()`.
 *
 * Re-uses the trivial stub conductor exported from `replay.test.ts`'s
 * fixture pattern to confirm the CLI returns a `ConformanceReport` with
 * the expected shape and respects `--format json`.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConformanceCommand } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claustrum-conf-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMinimalConductorModule(): Promise<string> {
  const content = `
const stubAdjudicator = {
  async adjudicate(){ return { kind: "EXECUTE", basis: [] }; },
  async adjudicatePlan(){ return { kind: "EXECUTE", basis: [] }; },
  async replayEnvelopesByCustomerId(){ return []; },
  streamAuditByIntentHashPrefix(){ return { [Symbol.asyncIterator](){ return { async next(){ return { done: true, value: undefined }; } }; } }; },
  async getOutcomes(){ return []; },
  verifyAuditRecord(){ return { ok: true }; },
};
const stubTools = {
  list(){ return []; },
  resolveCapabilities(){ return []; },
  resolveTool(){ throw new Error("no tool"); },
  register(){},
};
const stubChannel = {
  kind: "web",
  async perceive(x){ return x; },
  async render(){},
  async attest(e){ return { envelope: e, signature: "stub", keyId: "k", alg: "stub" }; },
};

let __session;
function makeSession(){
  const session = {
    id: "conv",
    customerId: "demo",
    channel: "web",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingConfirmations: [],
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: { summary: "", facts: [], updatedAt: new Date().toISOString() },
  };
  return {
    async load(){ return session; },
    async save(){},
    current(){ return session; },
    async parkPendingConfirmation(){},
    async parkDeferred(){},
    async unpark(){},
    isStale(){ return false; },
  };
}
const stubMemory = {
  async recall(){ return { customerId: "demo", episodic: [], semantic: [], procedural: [], relational: [], assembledAt: new Date().toISOString() }; },
  async observe(){},
  async search(){ return []; },
  async recentActions(){ return []; },
};

export function createConductor() {
  __session = makeSession();
  const stubGrounding = {
    async retrieve(){ return { docs: [], retrievedAt: new Date().toISOString(), modelId: "stub" }; },
    async attestGrounding(){ return []; },
  };
  const stubPlanner = { async propose(){ return { envelopes: [] }; } };
  const stubResponder = { async respond(){ return { text: "Echo." }; } };
  const stubExplainer = { render(r){ return r.userFacing; } };
  const stubHandoff = { async queue(){} };
  const stubTelemetry = { async emitTurn(){}, async emitLLMTrace(){}, async emitMemoryAccess(){} };

  return {
    adjudicator: stubAdjudicator,
    channels: { web: stubChannel },
    sessions: __session,
    memory: stubMemory,
    tools: stubTools,
    async openCapsule(input){
      const session = __session.current();
      return {
        tenant: { tenantId: "t", displayName: "T", locale: "en", environment: "dev" },
        customerId: input.customerId,
        actor: { principal: "user", sessionId: session.id },
        conversationId: input.inbound.conversationId,
        turnId: "t1",
        traceId: "tr1",
        channel: input.channel,
        locale: "en",
        environment: "dev",
        memory: stubMemory,
        grounding: stubGrounding,
        planner: stubPlanner,
        tools: stubTools,
        channels: { web: stubChannel },
        responder: stubResponder,
        adjudicator: stubAdjudicator,
        explainer: stubExplainer,
        handoff: stubHandoff,
        telemetry: stubTelemetry,
        session: __session,
        state: {},
        policy: {},
        async adjudicate(env){ return stubAdjudicator.adjudicate(env, {}, {}); },
        async adjudicatePlan(envs){ return stubAdjudicator.adjudicatePlan(envs, {}, {}); },
      };
    },
    async closeCapsule(){},
  };
}
`;
  const filePath = path.join(tmpDir, "conductor.mjs");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("runConformanceCommand", () => {
  it("returns a ConformanceReport when conductor loads cleanly", async () => {
    const conductorPath = await writeMinimalConductorModule();
    const result = await runConformanceCommand({
      conductor: conductorPath,
      sampling: 3,
      seed: 7,
      format: "json",
      exitOnError: false,
    });
    // The minimal stub conductor returns empty envelopes; the bundled
    // few-shot fixture for "refund-request" expects [danger] envelopes,
    // so CC-006 diverges against this stub. We assert that the report
    // ran (6 results) — pass/fail is a meaningful runtime signal for
    // adopters but not the unit under test here.
    expect(result.report).toBeDefined();
    expect(result.report?.results.length).toBeGreaterThanOrEqual(6);
    const ids = result.report?.results.map((r) => r.id) ?? [];
    expect(ids).toContain("CC-001");
    expect(ids).toContain("CC-006");
  });

  it("returns error when conductor module is missing createConductor", async () => {
    const badPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(badPath, "export const x = 1;\n", "utf8");
    const result = await runConformanceCommand({
      conductor: badPath,
      sampling: 1,
      format: "json",
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("createConductor");
  });
});

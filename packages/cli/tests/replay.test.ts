/**
 * `claustrum replay` — load adopter conductor, replay a turn, compare to
 * expected.
 *
 * We use `tsx` semantics indirectly: the tests import the conductor
 * fixture via the `loadConductorFactory` API which uses dynamic-import.
 * To exercise that path against a TS file without compilation, the
 * fixture is `tests/fixtures/test-conductor.ts` and we point the loader
 * at the corresponding `.ts` file using `tsx`'s register hook — but to
 * keep the test self-contained without registration, we re-export the
 * factory directly and pass a "file://" URL to a transpiled .js stub
 * via a small inline workaround: write a temporary .mjs file that
 * dynamically imports the source through `import("tsx/esm")`.
 *
 * Simpler approach used here: build a temp .mjs file that exports a
 * `createConductor` function directly (no @claustrum/core import in the
 * .mjs file — it would not resolve from the temp dir). We rely on the
 * `loadConductorFactory` API being module-agnostic.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReplay } from "../src/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claustrum-replay-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeMinimalConductorModule(): Promise<string> {
  // A trivial Conductor-shaped object exported via createConductor. It
  // exposes just enough surface for runReplay's call chain.
  const content = `
const stubChannel = {
  kind: "web",
  async perceive(x){ return x; },
  async render(){},
  async attest(e){ return { envelope: e, signature: "stub", keyId: "k", alg: "stub" }; }
};
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
  resolveTool(){ throw new Error("no tool registered"); },
  register(){},
};
const stubSessionFactory = () => {
  const session = {
    id: "demo-conv",
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
    async parkPendingConfirmation(){},
    async parkDeferred(){},
    async unpark(){},
    isStale(){ return false; },
  };
};

let __session;

export function createConductor() {
  __session = stubSessionFactory();
  const stubMemory = {
    async recall(){ return { customerId: "demo", episodic: [], semantic: [], procedural: [], relational: [], assembledAt: new Date().toISOString() }; },
    async observe(){},
    async search(){ return []; },
    async recentActions(){ return []; },
  };
  const stubGrounding = {
    async retrieve(){ return { docs: [], retrievedAt: new Date().toISOString(), modelId: "stub" }; },
    async attestGrounding(){ return []; },
  };
  const stubPlanner = { async propose(){ return { envelopes: [] }; } };
  const stubResponder = { async respond(){ return { text: "Echo." }; } };
  const stubExplainer = { render(r){ return r.userFacing; } };
  const stubHandoff = { async queue(){} };
  const stubTelemetry = {
    async emitTurn(){}, async emitLLMTrace(){}, async emitMemoryAccess(){},
  };

  return {
    adjudicator: stubAdjudicator,
    channels: { web: stubChannel },
    sessions: __session,
    memory: stubMemory,
    tools: stubTools,
    async openCapsule(input){
      const session = await __session.load(input.customerId, input.channel);
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
        loadedSession: session,
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

async function writeTurnFile(turn: object): Promise<string> {
  const filePath = path.join(tmpDir, "turn.json");
  await fs.writeFile(filePath, JSON.stringify(turn, null, 2), "utf8");
  return filePath;
}

describe("runReplay", () => {
  it("loads the conductor and matches expected decision (EXECUTE)", async () => {
    const conductorPath = await writeMinimalConductorModule();
    const turnPath = await writeTurnFile({
      channel: "web",
      customerId: "demo",
      text: "hello",
      receivedAt: "2026-05-18T00:00:00.000Z",
      expectedDecisionKind: "EXECUTE",
    });
    const result = await runReplay("t-1", {
      conductor: conductorPath,
      turn: turnPath,
      format: "json",
      exitOnError: false,
    });
    expect(result.ok).toBe(true);
    expect(result.observedDecisionKind).toBe("EXECUTE");
    expect(result.diverged).toBe(false);
  });

  it("flags divergence when expected kind differs from observed", async () => {
    const conductorPath = await writeMinimalConductorModule();
    const turnPath = await writeTurnFile({
      channel: "web",
      customerId: "demo",
      text: "hello",
      receivedAt: "2026-05-18T00:00:00.000Z",
      expectedDecisionKind: "REFUSE", // mismatch
    });
    const result = await runReplay("t-2", {
      conductor: conductorPath,
      turn: turnPath,
      format: "json",
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
    expect(result.diverged).toBe(true);
  });

  it("errors clearly when the conductor module has no createConductor export", async () => {
    const badPath = path.join(tmpDir, "bad.mjs");
    await fs.writeFile(badPath, "export const other = 1;\n", "utf8");
    const turnPath = await writeTurnFile({
      channel: "web",
      customerId: "demo",
      text: "x",
    });
    const result = await runReplay("t-3", {
      conductor: badPath,
      turn: turnPath,
      format: "json",
      exitOnError: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("createConductor");
  });
});

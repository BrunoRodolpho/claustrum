/**
 * T3-0 / DR-4 — two-process trigger-vs-chat serialization.
 *
 * The race this guards: a server-resident agent's trigger turn (channel
 * "system") and a human chat turn (channel "web") for the SAME customer run
 * on two different Node processes. Under the default lock key
 * (`${channel}:${customerId}`) they derive DIFFERENT keys
 * (`system:cust-1` vs `web:cust-1`) and never contend — both adjudicate
 * concurrently and the audit ledger interleaves one customer's rows.
 *
 * The fix under test: the trigger conductor installs
 * `sessionKeyAwareLockKey` and the trigger turn supplies an explicit
 * `sessionKey` naming the entity-scoped serialization domain (the customer's
 * chat lock key, `web:cust-1`). Both processes then contend on the same
 * `PostgresAdvisorySessionLock` key and the turns strictly serialize.
 *
 * "Two processes" is modeled as two independent Conductor instances (each
 * with its own session store, adjudicator instance, and its own
 * `PostgresAdvisorySessionLock`) sharing ONE advisory-lock domain — the
 * FakePool harness from advisory-session-lock.test.ts, which simulates
 * Postgres advisory-lock semantics with a shared held-set (the role the
 * shared Postgres plays in production).
 */

import { describe, expect, it } from "vitest";
import type { AuditRecord, Decision, IntentEnvelope } from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  sessionKeyAwareLockKey,
  type Adjudicator,
  type AuditVerification,
  type Conductor,
  type MemoryPort,
  type OpenCapsuleInput,
  type PolicyBundle,
  type SessionPort,
  type SystemState,
  type TenantResolver,
} from "@claustrum/core";
import {
  PostgresAdvisorySessionLock,
  type AdvisoryLockClient,
  type AdvisoryLockPool,
} from "../src/advisory-session-lock.js";

const FIXED_NOW = "2026-06-12T12:00:00.000Z";
const CUSTOMER = "cust-1";

// ── Shared advisory-lock domain (the "one Postgres" both processes see) ────
class FakePool implements AdvisoryLockPool {
  readonly held = new Set<string>();

  async connect(): Promise<AdvisoryLockClient> {
    const held = this.held;
    return {
      async query(sql: string, params: readonly unknown[]) {
        const id = String(params[0]);
        if (sql.includes("pg_try_advisory_lock")) {
          if (held.has(id)) return { rows: [{ locked: false }] };
          held.add(id);
          return { rows: [{ locked: true }] };
        }
        if (sql.includes("pg_advisory_unlock")) {
          held.delete(id);
          return { rows: [{ unlocked: true }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
  }
}

// ── Shared audit ledger (the rows whose ordering DR-4 is about) ─────────────
type LedgerRow = { readonly turn: string; readonly event: string };

/** Adjudicator stub appending to the SHARED ledger (one per process). */
function makeAdjudicator(ledger: LedgerRow[], turnLabel: () => string): Adjudicator {
  return {
    async adjudicate(
      _envelope: IntentEnvelope,
      _state: SystemState,
      _policy: PolicyBundle,
    ): Promise<Decision> {
      ledger.push({ turn: turnLabel(), event: "audit" });
      return { kind: "EXECUTE", basis: [] };
    },
    async adjudicatePlan(): Promise<Decision> {
      return { kind: "EXECUTE", basis: [] };
    },
    async replayEnvelopesByCustomerId(): Promise<ReadonlyArray<AuditRecord>> {
      return [];
    },
    streamAuditByIntentHashPrefix(): AsyncIterable<AuditRecord> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { value: undefined, done: true as const };
            },
          };
        },
      };
    },
    async getOutcomes() {
      return [];
    },
    verifyAuditRecord(): AuditVerification {
      return { ok: true };
    },
  };
}

// ── Minimal per-process ports (each process owns its instances) ─────────────
function makeSessionStore(): SessionPort {
  const byKey = new Map<string, Awaited<ReturnType<SessionPort["load"]>>>();
  return {
    async load(customerId, channel) {
      const key = `${channel}:${customerId}`;
      const existing = byKey.get(key);
      if (existing) return existing;
      const fresh = {
        id: key,
        customerId,
        channel,
        startedAt: FIXED_NOW,
        lastActivityAt: FIXED_NOW,
        pendingConfirmations: [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: FIXED_NOW },
      };
      byKey.set(key, fresh);
      return fresh;
    },
    async save(session) {
      byKey.set(session.id, session);
    },
    async parkPendingConfirmation() {},
    async parkDeferred() {},
    async unpark() {},
  };
}

const memory: MemoryPort = {
  async recall(customerId) {
    return {
      customerId,
      episodic: [],
      semantic: [],
      procedural: [],
      relational: [],
      assembledAt: FIXED_NOW,
    };
  },
  async observe() {},
  async search() {
    return [];
  },
  async recentActions() {
    return [];
  },
};

const tenantResolver: TenantResolver = {
  async resolve() {
    return {
      tenant: {
        tenantId: "t",
        displayName: "T",
        locale: "pt-BR",
        environment: "dev",
      },
      state: {},
      policy: {},
    };
  },
};

function makeProcessConductor(opts: {
  pool: FakePool;
  ledger: LedgerRow[];
  currentTurn: () => string;
  sessionKeyAware: boolean;
}): Conductor {
  return createConductor({
    adjudicator: makeAdjudicator(opts.ledger, opts.currentTurn),
    memory,
    grounding: {
      async retrieve() {
        return { docs: [], retrievedAt: FIXED_NOW, modelId: "stub" };
      },
      async attestGrounding() {
        return [];
      },
    },
    planner: {
      async propose() {
        return { envelopes: [] };
      },
    },
    responder: {
      async respond() {
        return { text: "ok" };
      },
    },
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: {
      async emitTurn() {},
      async emitLLMTrace() {},
      async emitMemoryAccess() {},
    },
    session: makeSessionStore(),
    tools: createToolRegistry(),
    channels: [],
    tenantResolver,
    sessionLock: new PostgresAdvisorySessionLock(opts.pool),
    ...(opts.sessionKeyAware ? { lockKeyStrategy: sessionKeyAwareLockKey } : {}),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One simulated turn: open the capsule (acquires the lock), do async work
 * with real yields (where an unserialized peer WOULD interleave), audit via
 * adjudicate, close (releases the lock). Events land on the shared ledger.
 */
async function runTurn(
  conductor: Conductor,
  input: OpenCapsuleInput,
  label: string,
  ledger: LedgerRow[],
): Promise<void> {
  const capsule = await conductor.openCapsule(input);
  try {
    ledger.push({ turn: label, event: "open" });
    await sleep(20); // planner/model latency — the interleave window
    await capsule.adjudicate({ kind: "pix.regenerate" } as unknown as IntentEnvelope);
    await sleep(10); // dispatch latency
    ledger.push({ turn: label, event: "close" });
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

function chatInput(): OpenCapsuleInput {
  return {
    channel: "web",
    customerId: CUSTOMER,
    sessionKey: "sess-tab-1", // per-conversation sessionKey, as real chat routes pass
    inbound: {
      channel: "web",
      customerId: CUSTOMER,
      conversationId: "conv-web-1",
      text: "cadê meu pedido?",
      receivedAt: FIXED_NOW,
    },
  };
}

function triggerInput(): OpenCapsuleInput {
  return {
    channel: "system",
    customerId: CUSTOMER,
    // DR-4: the trigger turn names the entity-scoped serialization domain —
    // the customer's chat lock key — so it contends with live chat turns.
    sessionKey: `web:${CUSTOMER}`,
    actor: {
      principal: "system",
      role: "system",
      sessionId: `agent:pix-remediation@1:entity:${CUSTOMER}`,
      customerId: CUSTOMER,
    },
    inbound: {
      channel: "system",
      customerId: CUSTOMER,
      conversationId: `trigger:payment.status_changed:${CUSTOMER}`,
      externalId: "ibatexas.payment.status_changed:evt-001",
      text: "payment.status_changed pix_failed",
      receivedAt: FIXED_NOW,
    },
  };
}

/** Index range [first, last] of a turn's rows in the shared ledger. */
function range(ledger: LedgerRow[], turn: string): { first: number; last: number } {
  const idx = ledger
    .map((row, i) => (row.turn === turn ? i : -1))
    .filter((i) => i >= 0);
  expect(idx.length).toBeGreaterThan(0);
  return { first: idx[0]!, last: idx[idx.length - 1]! };
}

describe("trigger-vs-chat serialization across two processes (T3-0 / DR-4)", () => {
  it("strictly serializes a concurrent trigger turn and chat turn for one customer", async () => {
    const pool = new FakePool();
    const ledger: LedgerRow[] = [];

    // Process A: the chat replica — DEFAULT lock strategy (unchanged behavior).
    const chatProcess = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "chat",
      sessionKeyAware: false,
    });
    // Process B: the agent host — opts into the DR-4 strategy.
    const triggerProcess = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "trigger",
      sessionKeyAware: true,
    });

    await Promise.all([
      runTurn(chatProcess, chatInput(), "chat", ledger),
      runTurn(triggerProcess, triggerInput(), "trigger", ledger),
    ]);

    // Both turns ran and audited.
    expect(ledger.filter((r) => r.event === "audit")).toHaveLength(2);

    // STRICT serialization: the two turns' ledger rows must not interleave —
    // one turn's whole [open..close] window precedes the other's.
    const chat = range(ledger, "chat");
    const trigger = range(ledger, "trigger");
    const serialized = chat.last < trigger.first || trigger.last < chat.first;
    expect(serialized, `ledger interleaved: ${JSON.stringify(ledger)}`).toBe(true);

    // No lock leaked.
    expect(pool.held.size).toBe(0);
  });

  it("NEGATIVE CONTROL: without the DR-4 strategy the same two turns interleave (the race the strategy closes)", async () => {
    const pool = new FakePool();
    const ledger: LedgerRow[] = [];

    const chatProcess = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "chat",
      sessionKeyAware: false,
    });
    // Agent host WITHOUT the strategy: default key `system:cust-1` never
    // contends with chat's `web:cust-1`.
    const triggerProcess = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "trigger",
      sessionKeyAware: false,
    });

    await Promise.all([
      runTurn(chatProcess, chatInput(), "chat", ledger),
      runTurn(triggerProcess, triggerInput(), "trigger", ledger),
    ]);

    const chat = range(ledger, "chat");
    const trigger = range(ledger, "trigger");
    const serialized = chat.last < trigger.first || trigger.last < chat.first;
    // Overlap observed — this is what proves the positive test has teeth.
    expect(serialized).toBe(false);
    expect(pool.held.size).toBe(0);
  });

  it("serializes two concurrent TRIGGER turns for the same entity from two agent-host processes", async () => {
    const pool = new FakePool();
    const ledger: LedgerRow[] = [];

    const hostA = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "trigger-a",
      sessionKeyAware: true,
    });
    const hostB = makeProcessConductor({
      pool,
      ledger,
      currentTurn: () => "trigger-b",
      sessionKeyAware: true,
    });

    await Promise.all([
      runTurn(hostA, triggerInput(), "trigger-a", ledger),
      runTurn(hostB, triggerInput(), "trigger-b", ledger),
    ]);

    const a = range(ledger, "trigger-a");
    const b = range(ledger, "trigger-b");
    expect(a.last < b.first || b.last < a.first).toBe(true);
    expect(pool.held.size).toBe(0);
  });
});

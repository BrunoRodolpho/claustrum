/**
 * DR-4 — Conductor lock-key strategy.
 *
 * The per-session lock KEY is derived by an optional `LockKeyStrategy`:
 *  - DEFAULT (no strategy): `${channel}:${customerId}` — byte-identical to
 *    pre-0.3 behavior. `input.sessionKey` is deliberately IGNORED for
 *    locking (it feeds actor.sessionId / TenantResolver only), because
 *    conversational callers pass per-conversation sessionKeys and narrowing
 *    the lock below the (customerId, channel) session-storage domain would
 *    reintroduce the RC-R3 race.
 *  - `sessionKeyAwareLockKey` (opt-in): an explicit `sessionKey` IS the lock
 *    key — the caller owns the serialization domain. Built for trigger turns
 *    (channel "system") that must serialize against the chat turns of the
 *    entity they act on.
 */

import { describe, expect, it } from "vitest";
import {
  createConductor,
  createToolRegistry,
  defaultLockKey,
  sessionKeyAwareLockKey,
  type ConductorOptions,
  type ChannelMessage,
  type OpenCapsuleInput,
  type ResponderPort,
  type TenantResolver,
} from "../src/index.js";
import type {
  SessionLock,
  SessionLockHandle,
} from "../src/ports/session-lock.js";
import {
  EmptyGroundingProvider,
  InMemoryMemoryProvider,
  InMemorySessionStore,
  RecordingTelemetrySink,
  StubAdjudicator,
  WebChannelStub,
} from "../src/test-doubles/index.js";

const FIXED_NOW = "2026-06-12T12:00:00.000Z";

/** SessionLock that records every key it is asked to acquire. */
class RecordingSessionLock implements SessionLock {
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  async acquire(key: string): Promise<SessionLockHandle> {
    this.acquired.push(key);
    return {
      key,
      release: async () => {
        this.released.push(key);
      },
    };
  }
}

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

const responder: ResponderPort = {
  async respond(): Promise<{ text: string }> {
    return { text: "ok" };
  },
};

function makeConductor(opts: {
  lock: RecordingSessionLock;
  lockKeyStrategy?: ConductorOptions["lockKeyStrategy"];
}) {
  return createConductor({
    adjudicator: new StubAdjudicator(),
    memory: new InMemoryMemoryProvider(),
    grounding: new EmptyGroundingProvider(),
    planner: { async propose() { return { envelopes: [] }; } },
    responder,
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: new RecordingTelemetrySink(),
    session: new InMemorySessionStore(),
    tools: createToolRegistry(),
    channels: [new WebChannelStub()],
    tenantResolver,
    sessionLock: opts.lock,
    ...(opts.lockKeyStrategy !== undefined
      ? { lockKeyStrategy: opts.lockKeyStrategy }
      : {}),
  });
}

function inbound(channel: "web" | "system", customerId: string): ChannelMessage {
  return {
    channel,
    customerId,
    conversationId: "conv-1",
    text: "oi",
    receivedAt: FIXED_NOW,
  };
}

describe("Conductor lock-key strategy (DR-4)", () => {
  it("default: locks `${channel}:${customerId}` and IGNORES a supplied sessionKey (pre-0.3 behavior)", async () => {
    const lock = new RecordingSessionLock();
    const conductor = makeConductor({ lock });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: "cust-1",
      sessionKey: "sess-conversation-abc", // conversational sessionKey — must NOT narrow the lock
      inbound: inbound("web", "cust-1"),
    });

    expect(lock.acquired).toEqual(["web:cust-1"]);
    // sessionKey still feeds the actor identity (unchanged contract).
    expect(capsule.actor.sessionId).toBe("sess-conversation-abc");

    await conductor.closeCapsule(capsule);
    expect(lock.released).toEqual(["web:cust-1"]);
  });

  it("sessionKeyAwareLockKey: an explicit sessionKey IS the lock key (trigger path owns the domain)", async () => {
    const lock = new RecordingSessionLock();
    const conductor = makeConductor({ lock, lockKeyStrategy: sessionKeyAwareLockKey });

    const capsule = await conductor.openCapsule({
      channel: "system",
      customerId: "cust-1",
      sessionKey: "web:cust-1", // entity-scoped serialization domain = the customer's chat lock key
      inbound: inbound("system", "cust-1"),
      actor: {
        principal: "system",
        role: "system",
        sessionId: "agent:pix-remediation@1:entity:cust-1",
        customerId: "cust-1",
      },
    });

    expect(lock.acquired).toEqual(["web:cust-1"]);
    expect(capsule.actor.sessionId).toBe("agent:pix-remediation@1:entity:cust-1");

    await conductor.closeCapsule(capsule);
    expect(lock.released).toEqual(["web:cust-1"]);
  });

  it("sessionKeyAwareLockKey: falls back to the default derivation when no sessionKey is supplied", async () => {
    const lock = new RecordingSessionLock();
    const conductor = makeConductor({ lock, lockKeyStrategy: sessionKeyAwareLockKey });

    const capsule = await conductor.openCapsule({
      channel: "web",
      customerId: "cust-2",
      inbound: inbound("web", "cust-2"),
    });

    expect(lock.acquired).toEqual(["web:cust-2"]);
    await conductor.closeCapsule(capsule);
  });

  it("strategy helpers are pure and deterministic over the input", () => {
    const base: OpenCapsuleInput = {
      channel: "system",
      customerId: "cust-9",
      inbound: inbound("system", "cust-9"),
    };
    expect(defaultLockKey(base)).toBe("system:cust-9");
    expect(defaultLockKey({ ...base, sessionKey: "anything" })).toBe("system:cust-9");
    expect(sessionKeyAwareLockKey(base)).toBe("system:cust-9");
    expect(sessionKeyAwareLockKey({ ...base, sessionKey: "web:cust-9" })).toBe(
      "web:cust-9",
    );
  });
});

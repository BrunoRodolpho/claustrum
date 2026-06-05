/**
 * RC-R3 residual: park/unpark target a session by id, never an implicit
 * "current"/"last loaded" handle.
 *
 * The original footgun: a SessionPort that held a single mutable `active`
 * session would attribute a parked envelope to whichever session loaded
 * last. Under concurrent turns for different customers that parks the
 * confirmation on the WRONG customer's session. These tests lock in the
 * session-scoped contract so a future adapter cannot reintroduce it.
 */

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../src/test-doubles/in-memory-session-store.js";

function envelope(nonce: string): IntentEnvelope {
  return buildEnvelope({
    kind: "pix.charge.refund",
    payload: { amount: 1 },
    actor: { principal: "user", sessionId: "s" },
    taint: "TRUSTED",
    nonce,
  });
}

describe("InMemorySessionStore — session-scoped park (RC-R3 footgun removal)", () => {
  it("parkPendingConfirmation lands on the session named by id, not the last loaded", async () => {
    const store = new InMemorySessionStore();
    const a = await store.load("cust-a", "web"); // id = "web:cust-a"
    const b = await store.load("cust-b", "web"); // loaded AFTER a

    // Park on A explicitly while B was the most recent load.
    await store.parkPendingConfirmation(a.id, envelope("n1"), "tok", "Confirm?");

    const aAfter = await store.load("cust-a", "web");
    const bAfter = await store.load("cust-b", "web");
    expect(aAfter.pendingConfirmations).toHaveLength(1);
    expect(aAfter.pendingConfirmations[0]?.confirmationToken).toBe("tok");
    // The footgun would have parked onto B (last loaded). It must not.
    expect(bAfter.pendingConfirmations).toHaveLength(0);
    expect(b.id).not.toBe(a.id);
  });

  it("parkDeferred lands on the session named by id", async () => {
    const store = new InMemorySessionStore();
    const a = await store.load("cust-a", "web");
    await store.load("cust-b", "web");

    await store.parkDeferred(a.id, envelope("n2"), "sig", "2025-01-01T00:00:00.000Z", 1000);

    const aAfter = await store.load("cust-a", "web");
    const bAfter = await store.load("cust-b", "web");
    expect(aAfter.deferredEnvelopes).toHaveLength(1);
    expect(aAfter.deferredEnvelopes[0]?.signal).toBe("sig");
    expect(bAfter.deferredEnvelopes).toHaveLength(0);
  });

  it("unpark removes a parked envelope only from the named session, by intentHash", async () => {
    const store = new InMemorySessionStore();
    const a = await store.load("cust-a", "web");
    const env = envelope("n3");
    await store.parkPendingConfirmation(a.id, env, "tok", "Confirm?");

    await store.unpark(a.id, env.intentHash);

    const aAfter = await store.load("cust-a", "web");
    expect(aAfter.pendingConfirmations).toHaveLength(0);
  });

  it("is a no-op when the named session is unknown (does not throw, parks nothing)", async () => {
    const store = new InMemorySessionStore();
    await expect(
      store.parkPendingConfirmation("web:nobody", envelope("n4"), "tok", "Confirm?"),
    ).resolves.toBeUndefined();
    await expect(
      store.parkDeferred("web:nobody", envelope("n5"), "sig", "2025-01-01T00:00:00.000Z", 1),
    ).resolves.toBeUndefined();
    await expect(store.unpark("web:nobody", "deadbeef")).resolves.toBeUndefined();
  });
});

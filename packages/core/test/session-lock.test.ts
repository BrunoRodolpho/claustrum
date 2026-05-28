/**
 * RC-R3: the per-session lock is the primitive that keeps "adjudicate() exactly
 * once per turn" true under concurrency. The Conductor acquires it in
 * openCapsule and releases it in closeCapsule, so two turns for the same session
 * serialize instead of both adjudicating.
 */

import { describe, it, expect } from "vitest";
import { InMemorySessionLock } from "../src/test-doubles/in-memory-session-lock.js";

describe("InMemorySessionLock (RC-R3)", () => {
  it("serializes concurrent acquires for the same key (FIFO)", async () => {
    const lock = new InMemorySessionLock();
    const h1 = await lock.acquire("web:cust-1");
    expect(h1).not.toBeNull();

    let h2Acquired = false;
    const p2 = lock.acquire("web:cust-1").then((h) => {
      h2Acquired = true;
      return h;
    });
    // Give p2 a tick to attempt; it must still be blocked by h1.
    await new Promise((r) => setTimeout(r, 5));
    expect(h2Acquired).toBe(false);

    await h1!.release();
    const h2 = await p2;
    expect(h2Acquired).toBe(true);
    expect(h2).not.toBeNull();
    await h2!.release();
  });

  it("does not block acquires for different keys", async () => {
    const lock = new InMemorySessionLock();
    const a = await lock.acquire("web:cust-a");
    const b = await lock.acquire("web:cust-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it("returns null on contention timeout (caller fails the turn closed)", async () => {
    const lock = new InMemorySessionLock();
    const h1 = await lock.acquire("web:cust-1");
    const h2 = await lock.acquire("web:cust-1", { timeoutMs: 15 });
    expect(h2).toBeNull();
    await h1!.release();
  });

  it("release is idempotent and frees the key for re-acquire", async () => {
    const lock = new InMemorySessionLock();
    const h = await lock.acquire("web:cust-1");
    await h!.release();
    await h!.release(); // no throw on double release
    const again = await lock.acquire("web:cust-1");
    expect(again).not.toBeNull();
    await again!.release();
  });
});

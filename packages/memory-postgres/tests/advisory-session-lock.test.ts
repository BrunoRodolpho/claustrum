/**
 * RC-R3 / Decision 1: PostgresAdvisorySessionLock serializes same-session turns
 * across processes via pg_advisory_lock. Tested against a fake pool that
 * simulates Postgres advisory-lock semantics (a shared held-set) so the
 * acquire/poll/release contract is verified without a live database.
 */

import { describe, it, expect } from "vitest";
import {
  PostgresAdvisorySessionLock,
  advisoryLockId,
  type AdvisoryLockClient,
  type AdvisoryLockPool,
} from "../src/advisory-session-lock.js";

class FakePool implements AdvisoryLockPool {
  readonly held = new Set<string>();
  connects = 0;
  releases = 0;

  async connect(): Promise<AdvisoryLockClient> {
    this.connects += 1;
    const held = this.held;
    const onRelease = () => {
      this.releases += 1;
    };
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
      release: onRelease,
    };
  }
}

describe("advisoryLockId", () => {
  it("is deterministic and positive", () => {
    const a = advisoryLockId("web:cust-1");
    expect(a).toBe(advisoryLockId("web:cust-1"));
    expect(BigInt(a) >= 0n).toBe(true);
  });
  it("differs per key", () => {
    expect(advisoryLockId("web:cust-1")).not.toBe(advisoryLockId("web:cust-2"));
  });
});

describe("PostgresAdvisorySessionLock (RC-R3)", () => {
  it("acquires when the advisory lock is free", async () => {
    const pool = new FakePool();
    const lock = new PostgresAdvisorySessionLock(pool);
    const h = await lock.acquire("web:cust-1");
    expect(h).not.toBeNull();
    expect(pool.held.size).toBe(1);
    await h!.release();
    expect(pool.held.size).toBe(0);
    expect(pool.releases).toBe(1); // connection returned to pool on release
  });

  it("blocks a concurrent same-key acquire until release (times out while held)", async () => {
    const pool = new FakePool();
    const lock = new PostgresAdvisorySessionLock(pool);
    const h1 = await lock.acquire("web:cust-1");
    const h2 = await lock.acquire("web:cust-1", { timeoutMs: 40 });
    expect(h2).toBeNull(); // still held by h1
    expect(pool.releases).toBe(1); // the timed-out attempt released its connection
    await h1!.release();
    const h3 = await lock.acquire("web:cust-1", { timeoutMs: 200 });
    expect(h3).not.toBeNull(); // free now
    await h3!.release();
  });

  it("does not block different keys", async () => {
    const pool = new FakePool();
    const lock = new PostgresAdvisorySessionLock(pool);
    const a = await lock.acquire("web:cust-a");
    const b = await lock.acquire("web:cust-b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });
});

/**
 * PostgresAdvisorySessionLock — the multi-process SessionLock (RC-R3 / Decision 1).
 *
 * Serializes turns for one session across ALL replicas using Postgres
 * session-level advisory locks (`pg_advisory_lock` / `pg_advisory_unlock`).
 * Unlike the in-process `InMemorySessionLock`, this is the correct primitive
 * for the v0.x multi-process contract: two webhooks racing on two different
 * Node processes cannot both adjudicate the same customer's turn.
 *
 * Connection pinning is load-bearing: a Postgres advisory lock is owned by the
 * backend connection that took it, so acquire and release MUST run on the SAME
 * connection. We therefore check out a dedicated client per lock and hold it
 * until release — never route lock/unlock through a pooled "any connection"
 * query. The lock is keyed by a deterministic 63-bit hash of the session key.
 *
 * Driver-agnostic: the pool interface is a minimal subset of node-postgres'
 * `Pool`/`PoolClient`, so adopters wire whatever client they already run.
 */

import { createHash } from "node:crypto";
import type { SessionLock, SessionLockHandle } from "@claustrum/core";

export interface AdvisoryLockClient {
  query(
    sql: string,
    params: readonly unknown[],
  ): Promise<{ readonly rows: ReadonlyArray<Record<string, unknown>> }>;
  /** Return the client to the pool. */
  release(): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

/**
 * Hash an arbitrary session key to a stable 63-bit signed-positive bigint
 * string suitable for `pg_advisory_lock(bigint)`. 63 bits keeps it within
 * Postgres' signed int8 positive range (no sign ambiguity across drivers).
 */
export function advisoryLockId(key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest();
  // Take the high 8 bytes, clear the top bit -> positive 63-bit integer.
  const hi = BigInt(digest.readUInt32BE(0)) & 0x7fffffffn;
  const lo = BigInt(digest.readUInt32BE(4));
  return ((hi << 32n) | lo).toString();
}

export class PostgresAdvisorySessionLock implements SessionLock {
  constructor(private readonly pool: AdvisoryLockPool) {}

  async acquire(
    key: string,
    opts?: { readonly timeoutMs?: number },
  ): Promise<SessionLockHandle | null> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lockId = advisoryLockId(key);
    const deadline = Date.now() + timeoutMs;
    const client = await this.pool.connect();

    try {
      for (;;) {
        const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
          lockId,
        ]);
        if (res.rows[0]?.["locked"] === true) {
          let released = false;
          return {
            key,
            async release() {
              if (released) return;
              released = true;
              try {
                await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
              } finally {
                client.release();
              }
            },
          };
        }
        if (Date.now() >= deadline) {
          client.release();
          return null;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      client.release();
      throw err;
    }
  }
}

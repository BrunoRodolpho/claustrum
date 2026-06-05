/**
 * SessionLock — per-session mutual exclusion for the cognitive loop.
 *
 * RC-R3 / Decision 1 (MULTI-PROCESS): "adjudicate() exactly once per turn" is
 * only true if two turns for the same session cannot run concurrently. Two
 * Twilio webhook retries, a multi-tab web client, or two replicas behind a load
 * balancer can each open a Capsule for the same customer at the same instant;
 * without a lock both turns independently call adjudicate() — one semantic
 * decision point produces two kernel records, both potentially EXECUTE, both
 * potentially mutating real state.
 *
 * The Conductor acquires a lock keyed by the session (`${channel}:${customerId}`)
 * in openCapsule and releases it in closeCapsule, so same-session turns
 * serialize. Because v0.x is a multi-process contract, the production
 * implementation MUST be distributed (Postgres advisory lock or Redis) — an
 * in-process mutex only protects a single replica. See
 * `@claustrum/memory-postgres` `PostgresAdvisorySessionLock`.
 */

export interface SessionLockHandle {
  /** The key this handle holds. */
  readonly key: string;
  /** Release the lock. Idempotent — safe to call once in a finally block. */
  release(): Promise<void>;
}

export interface SessionLock {
  /**
   * Acquire an exclusive lock for `key`, waiting up to `timeoutMs` for a
   * concurrent holder to release. Resolves with a handle when held, or `null`
   * if the timeout elapsed (the caller should fail the turn closed rather than
   * proceed unserialized). Implementations MUST be safe to call from multiple
   * processes when the deployment is multi-process.
   */
  acquire(
    key: string,
    opts?: { readonly timeoutMs?: number },
  ): Promise<SessionLockHandle | null>;
}

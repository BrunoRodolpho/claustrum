/**
 * InMemorySessionLock — single-process SessionLock for tests and dev.
 *
 * A per-key FIFO async mutex: acquire(key) waits for the current holder to
 * release, then hands the lock to the next waiter. Sufficient to serialize
 * same-session turns within ONE process. It does NOT serialize across
 * processes — multi-process deployments must use a distributed lock (see
 * @claustrum/memory-postgres PostgresAdvisorySessionLock).
 */

import type { SessionLock, SessionLockHandle } from "../ports/session-lock.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export class InMemorySessionLock implements SessionLock {
  /** Tail of the waiter chain per key; resolves when the current holder releases. */
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(
    key: string,
    opts?: { readonly timeoutMs?: number },
  ): Promise<SessionLockHandle | null> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const tails = this.tails;

    const prior = tails.get(key) ?? Promise.resolve();
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    // Chain: the next acquirer waits on `held`. Set the tail before awaiting
    // `prior` so ordering is FIFO and there is no acquire/acquire race.
    tails.set(key, held);

    const timedOut = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });

    const won = await Promise.race([prior.then(() => "acquired" as const), timeout]);
    if (timer !== undefined) clearTimeout(timer);

    if (won === timedOut) {
      // We never acquired, but we already installed `held` as the tail. Release
      // it so we don't deadlock the key, and only if no later waiter replaced us.
      releaseHeld();
      if (tails.get(key) === held) tails.delete(key);
      return null;
    }

    let released = false;
    return {
      key,
      async release() {
        if (released) return;
        released = true;
        // If no one queued behind us, drop the key so the map doesn't grow.
        if (tails.get(key) === held) tails.delete(key);
        releaseHeld();
      },
    };
  }
}

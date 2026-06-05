/**
 * Redis cache-key namespace + TTL constants.
 *
 * All keys are `claustrum:mem:<slot>:<customerId>` so a `KEYS claustrum:mem:*:cust-123`
 * yields the complete cache footprint for one customer (used by `observe()`'s
 * pipelined DEL on write-through invalidation).
 *
 * The hot-path snapshot has the shortest TTL (60s) so a stale snapshot
 * survives at most one hot-path call before re-assembly. Slow-changing kinds
 * (semantic facts, relational signals) carry longer TTLs to amortize Postgres
 * round-trips during read-heavy sessions.
 */

export const NAMESPACE = "claustrum:mem";

export const cacheKey = {
  /** Full assembled snapshot. `recall()` reads/writes this. */
  snapshot: (customerId: string): string =>
    `${NAMESPACE}:snap:${customerId}`,

  /** Semantic facts list (independent of snapshot for partial invalidation). */
  semantic: (customerId: string): string =>
    `${NAMESPACE}:sem:${customerId}`,

  /** Relational signals list. */
  relational: (customerId: string): string =>
    `${NAMESPACE}:rel:${customerId}`,

  /** Recent episodic turns (rolling window) — short TTL. */
  episodicRecent: (customerId: string): string =>
    `${NAMESPACE}:epi:recent:${customerId}`,

  /** Per-turn episodic envelope (idempotent re-observation). */
  episodicTurn: (customerId: string, turnId: string): string =>
    `${NAMESPACE}:epi:turn:${customerId}:${turnId}`,
} as const;

export const TTL_SECONDS = {
  /** Snapshot TTL — short enough that staleness is bounded by one hot-path call. */
  snapshot: 60,
  /** Semantic TTL — slow-changing facts, longer cache life. */
  semantic: 300,
  /** Relational TTL — emotional signals shift gradually. */
  relational: 300,
  /** Recent episodic TTL — covers an active conversation window. */
  episodicRecent: 120,
  /** Episodic turn TTL — long enough for replay-protection within a session. */
  episodicTurn: 3600,
} as const;

/** Shape of TTL overrides that can be passed to `PostgresMemoryProviderDeps.ttls`. */
export type TtlConfig = typeof TTL_SECONDS;

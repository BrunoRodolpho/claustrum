/**
 * `createPostgresMemoryProvider` — production MemoryProvider for @claustrum/*.
 *
 * Three load-bearing rules govern this adapter:
 *
 * 1. **Operational-memory boundary (CC-005).** `recentActions()` MUST route
 *    through `deps.adjudicator.replayEnvelopesByCustomerId(...)`. Raw SQL into
 *    `intent_audit` is forbidden — the kernel owns the audit ledger.
 *    `tests/recent-actions-boundary.test.ts` is the tripwire that catches
 *    regressions: it spies on every raw query and asserts the substring
 *    "intent_audit" never appears.
 *
 * 2. **Hot-path budget `recall()` p99 < 100ms.** Achieved via a Redis snapshot
 *    cache (60s TTL). On miss we issue 4 Postgres queries via Promise.all,
 *    reduce them with `buildSnapshot`, and SETEX the snapshot for the next
 *    caller. On hit we deserialize one string. The 1000-iteration warm-cache
 *    test enforces this budget against the mock client; a real cluster will
 *    only be faster.
 *
 * 3. **Write-through invalidation ordering.** `observe()` writes Postgres first
 *    inside a `$transaction`, then DELs the cache keys via a Redis pipeline.
 *    The reverse order would create a window where the snapshot survives a
 *    transactional rollback. The boundary test asserts this ordering by
 *    recording call timestamps on the mock.
 */

import type { AuditRecord } from "@adjudicate/core";
import type {
  Adjudicator,
  MemoryItem,
  MemoryPort,
  MemorySnapshot,
  Perception,
  TurnOutcome,
} from "@claustrum/core";
import { cacheKey, TTL_SECONDS, type TtlConfig } from "./cache-keys.js";
import { semanticSearch } from "./search.js";
import {
  buildSnapshot,
  type EpisodicRow,
  type ProceduralRow,
  type RelationalRow,
  type SemanticRow,
} from "./snapshot-builder.js";
import type {
  PrismaClientLike,
  RecallTimingHook,
  RedisClientLike,
} from "./types.js";

export interface PostgresMemoryProviderDeps {
  readonly prisma: PrismaClientLike;
  readonly redis: RedisClientLike;
  /**
   * Adjudicator port — the ONLY kernel surface this adapter uses, and the
   * sole way to read operational memory. Raw `intent_audit` SQL is forbidden.
   */
  readonly adjudicator: Adjudicator;
  /** Optional p99-timing hook. Adopters wire this to TelemetrySink.emitMemoryAccess. */
  readonly onRecallTiming?: RecallTimingHook;
  /**
   * Recall fan-out tuning. Defaults match the master plan (episodic 20,
   * semantic 50, procedural 10, relational 20).
   */
  readonly fanout?: {
    readonly episodic?: number;
    readonly semantic?: number;
    readonly procedural?: number;
    readonly relational?: number;
  };
  /** Minimum semantic-fact confidence included in the snapshot. Default 0.3. */
  readonly semanticMinConfidence?: number;
  /**
   * Optional TTL overrides (seconds). Any key omitted here falls back to
   * the module-level `TTL_SECONDS` defaults, so existing callers are
   * unaffected. Useful for tests or for deployments that need a longer
   * snapshot TTL in high-traffic environments.
   *
   * @example
   * createPostgresMemoryProvider({ prisma, redis, adjudicator,
   *   ttls: { snapshot: 120 } })  // double snapshot TTL, rest unchanged
   */
  readonly ttls?: Partial<TtlConfig>;
}

const DEFAULTS = {
  episodic: 20,
  semantic: 50,
  procedural: 10,
  relational: 20,
  semanticMinConfidence: 0.3,
} as const;

export function createPostgresMemoryProvider(
  deps: PostgresMemoryProviderDeps,
): MemoryPort {
  const fanoutEpisodic = deps.fanout?.episodic ?? DEFAULTS.episodic;
  const fanoutSemantic = deps.fanout?.semantic ?? DEFAULTS.semantic;
  const fanoutProcedural = deps.fanout?.procedural ?? DEFAULTS.procedural;
  const fanoutRelational = deps.fanout?.relational ?? DEFAULTS.relational;
  const semMinConf =
    deps.semanticMinConfidence ?? DEFAULTS.semanticMinConfidence;

  // Merge caller-supplied TTL overrides with module defaults. Any key not
  // present in deps.ttls falls back to TTL_SECONDS, preserving full
  // back-compat for callers that do not pass ttls at all.
  const ttls: TtlConfig = { ...TTL_SECONDS, ...deps.ttls };

  function reportTiming(durationMs: number, cacheHit: boolean): void {
    if (deps.onRecallTiming) {
      // Defensive: never let telemetry throwing leak into the hot path.
      try {
        deps.onRecallTiming(durationMs, cacheHit);
      } catch {
        // swallow
      }
    }
  }

  return {
    async recall(
      customerId: string,
      _perception: Perception,
    ): Promise<MemorySnapshot> {
      const t0 = performance.now();
      const snapKey = cacheKey.snapshot(customerId);

      // Hot path: Redis-only call when warm. JSON parse is the only cost.
      const cached = await deps.redis.get(snapKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as MemorySnapshot;
          reportTiming(performance.now() - t0, true);
          return parsed;
        } catch {
          // Corrupt cache entry — fall through to cold path. The DEL is fire-
          // and-forget; we don't await it because the SETEX below will
          // overwrite anyway.
          void deps.redis.del(snapKey);
        }
      }

      // Cold path: 4-way parallel fetch. The findMany shape mirrors what the
      // generated Prisma client returns; the structural type lets us swap
      // implementations without breaking this call site.
      const [episodicRows, semanticRows, proceduralRows, relationalRows] =
        await Promise.all([
          deps.prisma.claustrum_memory_episodic.findMany({
            where: { customer_id: customerId },
            orderBy: { recorded_at: "desc" },
            take: fanoutEpisodic,
          }) as Promise<EpisodicRow[]>,
          deps.prisma.claustrum_memory_semantic.findMany({
            where: {
              customer_id: customerId,
              confidence: { gte: semMinConf } as unknown as number,
            },
            orderBy: { confidence: "desc" },
            take: fanoutSemantic,
          }) as Promise<SemanticRow[]>,
          deps.prisma.claustrum_memory_procedural.findMany({
            where: { customer_id: customerId },
            orderBy: { last_used_at: "desc" },
            take: fanoutProcedural,
          }) as Promise<ProceduralRow[]>,
          deps.prisma.claustrum_memory_relational.findMany({
            where: { customer_id: customerId },
            orderBy: { observed_at: "desc" },
            take: fanoutRelational,
          }) as Promise<RelationalRow[]>,
        ]);

      const snapshot = buildSnapshot({
        customerId,
        episodic: episodicRows,
        semantic: semanticRows,
        procedural: proceduralRows,
        relational: relationalRows,
      });

      // Write-through. Fire-and-forget the SETEX — the snapshot is already
      // assembled; failing to cache only costs the next caller a re-fetch.
      void deps.redis.setex(
        snapKey,
        ttls.snapshot,
        JSON.stringify(snapshot),
      );

      reportTiming(performance.now() - t0, false);
      return snapshot;
    },

    async observe(customerId: string, turn: TurnOutcome): Promise<void> {
      // ORDER IS LOAD-BEARING:
      //   1. Postgres transaction commits (or rolls back as a unit).
      //   2. AFTER commit, Redis DEL the invalidated keys.
      //
      // Reversing this opens a window where the snapshot survives a rollback —
      // subsequent recalls would return data that doesn't exist in Postgres.
      // The boundary test asserts this ordering via call-timestamp comparison.
      await deps.prisma.$transaction(async (tx) => {
        // Episodic — always insert (one row per turn).
        await tx.claustrum_memory_episodic.create({
          data: {
            customer_id: customerId,
            turn_id: turn.turnId,
            conversation_id: turn.conversationId,
            user_text: turn.userText ?? null,
            response_text: turn.responseText ?? null,
            decision_kind: turn.decisionKind ?? null,
            intent_hash: turn.intentHash ?? null,
            recorded_at: new Date(turn.at),
          },
        });

        // Semantic — upsert tags-as-array seed from perception. Adopters
        // extend this in their own facts-extraction pass; the adapter writes
        // a minimal stub so the schema exercises end-to-end.
        if (turn.perception?.locale) {
          await tx.claustrum_memory_semantic.upsert({
            where: {
              customer_id_key: {
                customer_id: customerId,
                key: "locale",
              },
            },
            create: {
              customer_id: customerId,
              key: "locale",
              value: turn.perception.locale,
              confidence: 0.9,
              tags: ["perception"],
              recorded_at: new Date(turn.at),
            },
            update: {
              value: turn.perception.locale,
              confidence: 0.9,
              recorded_at: new Date(turn.at),
            },
          });
        }

        // Relational — record the channel as a low-weight social signal.
        if (turn.perception?.channel) {
          await tx.claustrum_memory_relational.create({
            data: {
              customer_id: customerId,
              signal_kind: "channel_touchpoint",
              content: turn.perception.channel,
              observed_at: new Date(turn.at),
            },
          });
        }
      });

      // Postgres committed. Now invalidate.
      const keys = [
        cacheKey.snapshot(customerId),
        cacheKey.semantic(customerId),
        cacheKey.relational(customerId),
        cacheKey.episodicRecent(customerId),
      ];
      await deps.redis.pipeline().del(...keys).exec();
    },

    async search(
      customerId: string,
      query: { readonly semantic?: string; readonly tags?: ReadonlyArray<string> },
      k: number,
    ): Promise<ReadonlyArray<MemoryItem>> {
      return semanticSearch(deps.prisma, customerId, query, k);
    },

    async recentActions(
      customerId: string,
      since: Date,
    ): Promise<ReadonlyArray<AuditRecord>> {
      // ── CC-005 boundary ──────────────────────────────────────────────────
      // Operational memory is owned by the kernel. This adapter never reads
      // `intent_audit` directly — it asks the Adjudicator port. The boundary
      // test asserts no raw query in this file references "intent_audit".
      return deps.adjudicator.replayEnvelopesByCustomerId(customerId, since);
    },
  };
}

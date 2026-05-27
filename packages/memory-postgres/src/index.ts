/**
 * @claustrum/memory-postgres — Postgres + Redis MemoryProvider.
 *
 * Public barrel. Adopters import `createPostgresMemoryProvider` and the
 * supporting types; the cache-key/snapshot internals are re-exported for
 * the conformance suite and for adopters that want fine-grained access
 * (e.g., a custom invalidation job).
 */

export {
  createPostgresMemoryProvider,
  type PostgresMemoryProviderDeps,
} from "./postgres-memory-provider.js";

export {
  cacheKey,
  NAMESPACE,
  TTL_SECONDS,
} from "./cache-keys.js";

export {
  buildSnapshot,
  type BuildSnapshotInput,
  type EpisodicRow,
  type SemanticRow,
  type ProceduralRow,
  type RelationalRow,
} from "./snapshot-builder.js";

export { semanticSearch } from "./search.js";

export type {
  PrismaClientLike,
  PrismaModelDelegate,
  RedisClientLike,
  RedisPipelineLike,
  RecallTimingHook,
  FindManyArgs,
  UpsertArgs,
  CreateArgs,
} from "./types.js";

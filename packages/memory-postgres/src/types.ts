/**
 * Minimal structural interfaces for `@prisma/client` and `ioredis`.
 *
 * Two reasons we type these ourselves instead of importing the real packages:
 *
 * 1. **Sandboxed install resilience.** In environments where `pnpm install`
 *    can't fetch the registry, the build must still compile against the
 *    structural shape so contract tests (mock-driven) keep running. The runtime
 *    Postgres+Redis is loaded by the adopter — they bring real clients.
 *
 * 2. **Decoupled migrations.** The Prisma schema in `prisma/` is the source of
 *    truth for the table shape, but we only use a tiny slice of the generated
 *    client surface (`findMany`, `upsert`, `create`, `$transaction`,
 *    `$queryRaw`). Hand-typing that slice keeps the test surface tractable and
 *    leaves the door open for swapping Prisma later without churning the
 *    public API.
 *
 * The dependency on `@prisma/client` and `ioredis` in `package.json` is the
 * production contract — adopters bring the implementations; we lean on
 * structural typing. The `unknown` escape hatch is intentional in `$queryRaw`
 * where Prisma's template-literal tag returns generic results.
 */

export interface FindManyArgs {
  readonly where?: Record<string, unknown>;
  readonly orderBy?:
    | Record<string, "asc" | "desc">
    | ReadonlyArray<Record<string, "asc" | "desc">>;
  readonly take?: number;
  readonly skip?: number;
  readonly select?: Record<string, boolean>;
}

export interface UpsertArgs<TWhere, TCreate, TUpdate> {
  readonly where: TWhere;
  readonly create: TCreate;
  readonly update: TUpdate;
}

export interface CreateArgs<TData> {
  readonly data: TData;
}

export interface PrismaModelDelegate<TRow> {
  findMany(args?: FindManyArgs): Promise<TRow[]>;
  create(args: CreateArgs<Record<string, unknown>>): Promise<TRow>;
  upsert(
    args: UpsertArgs<
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>
    >,
  ): Promise<TRow>;
  /** Bounded retention pruning (ScalabilityReviewer-005). */
  deleteMany(args: { readonly where: Record<string, unknown> }): Promise<{
    readonly count: number;
  }>;
  count(args?: { readonly where?: Record<string, unknown> }): Promise<number>;
}

/**
 * Structural Prisma client. We only require four delegates and `$transaction`.
 * `$queryRaw` is included for the cold-path semantic search (LIKE / tsvector).
 */
export interface PrismaClientLike {
  readonly claustrum_memory_episodic: PrismaModelDelegate<unknown>;
  readonly claustrum_memory_semantic: PrismaModelDelegate<unknown>;
  readonly claustrum_memory_procedural: PrismaModelDelegate<unknown>;
  readonly claustrum_memory_relational: PrismaModelDelegate<unknown>;
  $transaction<T>(
    fn: (tx: PrismaClientLike) => Promise<T>,
  ): Promise<T>;
  $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
}

/**
 * Structural Redis client. Just what we need from ioredis: get/setex/del +
 * a pipeline factory for atomic-ish invalidation.
 */
export interface RedisPipelineLike {
  del(...keys: string[]): this;
  exec(): Promise<unknown>;
}

export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  pipeline(): RedisPipelineLike;
}

/** Hook for adopters to record recall p99 timings without depending on TelemetrySink. */
export type RecallTimingHook = (
  durationMs: number,
  cacheHit: boolean,
) => void;

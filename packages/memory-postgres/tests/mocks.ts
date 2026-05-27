/**
 * Test fakes for Prisma + Redis + Adjudicator.
 *
 * Why hand-rolled vs. testcontainers: the boundary tripwire (CC-005) and the
 * write-order invariant are both observable from call records — no real DB
 * needed. Real-DB perf tests are a separate concern and skip-with-message
 * when testcontainers isn't installed.
 *
 * The mocks record every call so the boundary test can pattern-match raw SQL,
 * and the ordering test can compare timestamps between Postgres tx-commit
 * and the Redis pipeline.del.
 */

import type {
  AuditRecord,
  Decision,
  IntentEnvelope,
} from "@adjudicate/core";
import type {
  Adjudicator,
  AuditVerification,
  OutcomeFilter,
  OutcomeRow,
} from "@claustrum/core";
import type {
  PrismaClientLike,
  PrismaModelDelegate,
  RedisClientLike,
  RedisPipelineLike,
} from "../src/types.js";

export interface PrismaCall {
  readonly model: string;
  readonly op: string;
  readonly args: unknown;
  readonly at: number;
}

export interface RawSqlCall {
  readonly sql: string;
  readonly params: unknown[];
  readonly at: number;
}

export interface RedisCall {
  readonly op: string;
  readonly args: unknown[];
  readonly at: number;
}

export class FakePrismaModel<TRow> implements PrismaModelDelegate<TRow> {
  public readonly rows: TRow[] = [];
  public readonly calls: PrismaCall[] = [];
  private readonly modelName: string;
  private readonly findManyResponder: (() => TRow[]) | null;

  constructor(
    modelName: string,
    findManyResponder: (() => TRow[]) | null = null,
  ) {
    this.modelName = modelName;
    this.findManyResponder = findManyResponder;
  }

  async findMany(args?: unknown): Promise<TRow[]> {
    this.calls.push({
      model: this.modelName,
      op: "findMany",
      args,
      at: performance.now(),
    });
    return this.findManyResponder ? this.findManyResponder() : [...this.rows];
  }

  async create(args: { data: Record<string, unknown> }): Promise<TRow> {
    this.calls.push({
      model: this.modelName,
      op: "create",
      args,
      at: performance.now(),
    });
    const row = args.data as unknown as TRow;
    this.rows.push(row);
    return row;
  }

  async upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<TRow> {
    this.calls.push({
      model: this.modelName,
      op: "upsert",
      args,
      at: performance.now(),
    });
    const row = args.create as unknown as TRow;
    this.rows.push(row);
    return row;
  }
}

export class FakePrismaClient implements PrismaClientLike {
  public readonly claustrum_memory_episodic: FakePrismaModel<unknown>;
  public readonly claustrum_memory_semantic: FakePrismaModel<unknown>;
  public readonly claustrum_memory_procedural: FakePrismaModel<unknown>;
  public readonly claustrum_memory_relational: FakePrismaModel<unknown>;
  public readonly rawSqlCalls: RawSqlCall[] = [];
  public readonly transactionCommittedAt: number[] = [];

  constructor(opts?: {
    episodicRows?: unknown[];
    semanticRows?: unknown[];
    proceduralRows?: unknown[];
    relationalRows?: unknown[];
  }) {
    this.claustrum_memory_episodic = new FakePrismaModel(
      "claustrum_memory_episodic",
      opts?.episodicRows ? () => opts.episodicRows! : null,
    );
    this.claustrum_memory_semantic = new FakePrismaModel(
      "claustrum_memory_semantic",
      opts?.semanticRows ? () => opts.semanticRows! : null,
    );
    this.claustrum_memory_procedural = new FakePrismaModel(
      "claustrum_memory_procedural",
      opts?.proceduralRows ? () => opts.proceduralRows! : null,
    );
    this.claustrum_memory_relational = new FakePrismaModel(
      "claustrum_memory_relational",
      opts?.relationalRows ? () => opts.relationalRows! : null,
    );
  }

  async $transaction<T>(
    fn: (tx: PrismaClientLike) => Promise<T>,
  ): Promise<T> {
    const result = await fn(this);
    this.transactionCommittedAt.push(performance.now());
    return result;
  }

  async $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    const sql = strings.join("?");
    this.rawSqlCalls.push({ sql, params: values, at: performance.now() });
    return [];
  }

  async $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T[]> {
    this.rawSqlCalls.push({ sql: query, params: values, at: performance.now() });
    return [];
  }
}

class FakeRedisPipeline implements RedisPipelineLike {
  private readonly parent: FakeRedisClient;
  private readonly buffered: string[] = [];

  constructor(parent: FakeRedisClient) {
    this.parent = parent;
  }

  del(...keys: string[]): this {
    this.buffered.push(...keys);
    return this;
  }

  async exec(): Promise<unknown> {
    for (const key of this.buffered) {
      this.parent.store.delete(key);
    }
    this.parent.calls.push({
      op: "pipeline.del",
      args: [this.buffered],
      at: performance.now(),
    });
    return this.buffered.map((): [Error | null, number] => [null, 1]);
  }
}

export class FakeRedisClient implements RedisClientLike {
  public readonly store = new Map<string, string>();
  public readonly calls: RedisCall[] = [];

  async get(key: string): Promise<string | null> {
    this.calls.push({ op: "get", args: [key], at: performance.now() });
    return this.store.get(key) ?? null;
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    this.calls.push({
      op: "setex",
      args: [key, seconds, value],
      at: performance.now(),
    });
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.calls.push({ op: "del", args: keys, at: performance.now() });
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n += 1;
    return n;
  }

  pipeline(): RedisPipelineLike {
    return new FakeRedisPipeline(this);
  }
}

export class FakeAdjudicator implements Adjudicator {
  public readonly replayCalls: Array<{
    customerId: string;
    since?: Date;
  }> = [];
  public records: ReadonlyArray<AuditRecord> = [];

  async adjudicate(): Promise<Decision> {
    throw new Error("not used in memory-postgres tests");
  }

  async adjudicatePlan(): Promise<Decision> {
    throw new Error("not used in memory-postgres tests");
  }

  async replayEnvelopesByCustomerId(
    customerId: string,
    since?: Date,
  ): Promise<ReadonlyArray<AuditRecord>> {
    this.replayCalls.push({ customerId, since });
    return this.records;
  }

  streamAuditByIntentHashPrefix(): AsyncIterable<AuditRecord> {
    return {
      [Symbol.asyncIterator]: () => ({
        async next(): Promise<IteratorResult<AuditRecord>> {
          return { done: true, value: undefined as unknown as AuditRecord };
        },
      }),
    };
  }

  async getOutcomes(_filter: OutcomeFilter): Promise<ReadonlyArray<OutcomeRow>> {
    void _filter;
    return [];
  }

  verifyAuditRecord(_record: AuditRecord): AuditVerification {
    void _record;
    return { ok: true };
  }
}

// Helper to silence unused-import warnings for re-exported type symbols when
// downstream tests don't use them.
export type _ReExport = IntentEnvelope;

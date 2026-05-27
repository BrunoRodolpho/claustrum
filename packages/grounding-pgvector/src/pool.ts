/**
 * Minimal `Pool` shape — structurally compatible with `pg.Pool.query()`.
 *
 * We do NOT import `pg` at type-check time so the package builds without
 * `pg` installed in test environments (e.g. CI sandboxes). At runtime the
 * adopter passes a real `pg.Pool`; in tests we pass an in-memory mock.
 *
 * Only the subset we actually use is typed. If we ever need transactions
 * or pooled clients, extend this — but only to the surface area we call.
 */

export interface QueryResult<R> {
  readonly rows: ReadonlyArray<R>;
}

export interface Pool {
  query<R = unknown>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}

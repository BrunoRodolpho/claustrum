# Production-Readiness Checklist (runtime-side)

> Operational tuning a `@claustrum/core`-based adopter must apply before
> production. The runtime is **dependency-injected**: it does not construct SDK
> clients, connection pools, or set timeouts on the adopter's behalf. That is
> deliberate — the adopter owns its transport and persistence layer — but it
> means the safe defaults below are **not** applied automatically. The examples
> (`examples/minimal-chat`, `examples/healthcare-stub`) construct clients bare
> for brevity and are **illustrative, not normative**: do not copy their
> client/pool wiring into production unchanged.

This document covers the five operational surfaces the audit flagged as
under-documented:

1. Model-provider SDK timeouts and retries.
2. pgvector / Prisma connection pool sizing and `statement_timeout`.
3. The `TenantResolver.resolve()` per-turn caching contract.
4. Fragment-registry boundedness and per-replica replay.
5. The Redis `SessionLock` implementation (UUID token + Lua release + heartbeat).

---

## 1. Model-provider SDK: timeouts and retries

The shipped examples build the Anthropic SDK with only an API key:

```ts
// examples/minimal-chat/src/index.ts — ILLUSTRATIVE
const client = wrapAnthropicSdk(new Anthropic({ apiKey }));
return new AnthropicProvider({ client });
```

A bare `new Anthropic({ apiKey })` / `new OpenAI({ apiKey })` inherits the SDK's
**defaults**, which are tuned for scripts, not a request-serving cognitive loop:
the official SDKs default to a ~10-minute request timeout and several automatic
retries. A stalled LLM call therefore hangs a turn far longer than any
interactive channel (WhatsApp, web chat) should tolerate.

The runtime threads an `AbortSignal` into `ModelProvider.complete`/`stream`, but
**nothing in the framework populates a deadline** (this is the open
`ConcurrencyReviewer-003`/`NetworkReviewer-001` port-threading item). Until that
lands, the SDK client's own timeout is the only backstop — so set it.

**Do this in production:**

```ts
// Anthropic
const client = wrapAnthropicSdk(
  new Anthropic({
    apiKey,
    timeout: 30_000,   // per-request, ms — well under any interactive channel budget
    maxRetries: 2,     // SDK-level retry on 429 / 5xx / connection error
  }),
);

// OpenAI (same options surface)
new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 });
```

Guidance:

- **`timeout`** — pick a value below your channel's user-facing budget. ~30s is a
  reasonable interactive default; raise it only for deliberately long
  completions and lower it for latency-sensitive surfaces.
- **`maxRetries`** — the SDK already honours `Retry-After`. `@claustrum/core`
  also ships `retryWithBackoff` (consuming the providers' parsed `retryAfterMs`,
  see `NetworkReviewer-011`) for app-level retry; do not stack aggressive retry
  at both layers or you multiply tail latency. Pick one primary retry layer.
- **Embeddings** — `ModelProvider.embed` has no signal parameter today; its only
  bound is the same SDK-level `timeout`. Set the client timeout and treat embed
  as part of the cold-recall / grounding budget below.
- **Cancelled-stream spend** — an aborted stream still bills for tokens emitted
  before the abort; the providers now carry running token counts onto the
  `cancelled` chunk (`NetworkReviewer-006`). Make sure your `TelemetryPort`
  records usage on cancelled turns, not just completed ones.

---

## 2. pgvector / Prisma connection pools and `statement_timeout`

Both Postgres-backed adapters take an **injected pool** — the runtime never
opens connections itself:

- `@claustrum/grounding-pgvector` — `PgVectorGroundingProvider` takes
  `{ pool }` (a `pg.Pool`-shaped object); see `src/pgvector-grounding-provider.ts`.
- `@claustrum/memory-postgres` — `recall()` issues **4 Postgres queries via
  `Promise.all`** on every cold (cache-miss) read; see the hot-path note in
  `src/postgres-memory-provider.ts`.

### Pool sizing — account for the cold-recall fan-out

The memory cold path is the sizing driver. On a Redis snapshot miss (60s TTL),
**one** `recall()` consumes **4 pooled connections simultaneously**. Under a
burst of N concurrent cold recalls (a retried webhook, a multi-tab user, a
post-`observe` cache invalidation) you need up to **4 × N** connections before
requests start queueing on the pool.

- Size the `pg.Pool` `max` (and any pgBouncer / Prisma `connection_limit`) for
  the **4×-per-cold-recall** fan-out, not for one-query-per-request.
- `PerformanceReviewer-001` (single-flight `recall()`) is the open mitigation —
  until it lands, assume **no** cold-path deduplication: every concurrent
  cache-miss for the same `customerId` independently fires its own 4 queries.
- The Redis snapshot cache (`snapshot: 60` in `cache-keys.ts`, overridable via
  `PostgresMemoryProviderDeps.ttls`) is what keeps the warm path off Postgres.
  Tune the TTL to your read/write ratio: a longer TTL cuts Postgres load but
  widens the post-`observe` staleness window.
- Grounding (`retrieve.ts`) is one k-NN query per turn against the HNSW index
  (`vector(1536)`, `vector_cosine_ops`; migration 001). It is far less
  connection-hungry than memory recall but shares the same pool budget if you
  point both adapters at one Postgres.

If grounding and memory share a Postgres instance, **size one pool for the sum**,
or give each adapter its own pool so a grounding spike cannot starve recall.

### `statement_timeout`

Neither adapter sets a server-side `statement_timeout`, and the SDK/pool
client-side timeout does **not** stop the query running inside Postgres — it only
abandons the client. A pathological k-NN scan (cold HNSW, missing/oversized
index) or a memory query against an unindexed table can pin a backend
indefinitely.

Set a `statement_timeout` so a slow query fails fast instead of holding a pooled
connection. Either per-role:

```sql
ALTER ROLE claustrum_app SET statement_timeout = '5s';
```

or via the connection string (`...?options=-c%20statement_timeout%3D5000`), or
per-pool client on `connect`. Pick a ceiling above your p99 query latency but
well below the pool-exhaustion cliff. Pair it with pool-level
`idle_in_transaction_session_timeout` to reap leaked transactions.

---

## 3. `TenantResolver.resolve()` — the per-turn caching contract

`TenantResolver.resolve({ channel, customerId, sessionKey? })` is called **once
per turn** by the Conductor (`packages/core/src/ports/tenant.ts`) to produce the
`{ tenant, state, policy }` for `adjudicate()`. The Conductor does **not** cache
its result — it calls `resolve()` fresh on every inbound message.

**Implication:** whatever `resolve()` does runs on the cognitive-loop hot path,
synchronously gating every turn before PLAN. If your implementation hits a DB,
a config service, or a policy store, that latency is added to **every** turn.

Guidance:

- **Single-tenant** adopters return a constant — no caching concern; keep it
  allocation-light (don't rebuild the `PolicyBundle` per call if it is static).
- **Multi-tenant** adopters that fetch tenant config / policy per call should
  cache **inside the resolver** with a short TTL keyed by tenant, and accept the
  staleness that implies. A tenant config / policy change then takes up to one
  TTL to propagate — document that window for your operators.
- The resolver returns the **`SystemState` snapshot** passed to the kernel. If
  that snapshot is itself expensive to assemble (e.g. it reads live balances or
  feature state), the freshness/cost trade-off is yours to make and document —
  the runtime treats the returned snapshot as authoritative for the turn.

There is no framework-level resolver cache by design (the runtime cannot know
your invalidation semantics). If you need one, it lives in your `TenantResolver`.

---

## 4. Fragment-registry boundedness and per-replica replay

`PromptComposer`'s fragment registry stores fragments in an in-memory `Map`
keyed by `id` (`packages/core/src/prompting/fragment-registry.ts`). Two
operational properties follow:

### Boundedness

The registry is **unbounded** — it grows with every distinct `register()` `id`.
This is fine for the intended usage (fragments registered **once at boot** from a
static catalogue: a fixed number of system/policy/persona fragments). It is **not**
a per-turn or per-tenant cache:

- **Do** register the full fragment catalogue at startup and leave it.
- **Do not** `register()` per turn, per customer, or with request-derived `id`s —
  that turns the registry into an unbounded process-lifetime leak.
- A multi-tenant deployment that needs per-tenant fragments should use distinct,
  **bounded** `id`s (e.g. namespaced by tenant) registered at boot, not minted at
  request time. The set of fragment `id`s must be finite and known ahead of time.

### Per-replica replay

The `fragmentManifest` recorded in every `LLMTrace` (Hard Rule #5) lets you
**replay a prompt by hash** months later — but only if the fragment that
produced each manifested entry is **still registered with byte-identical
content**. Operationally:

- The registry is **per-replica, in-process**. It is rebuilt from your boot-time
  registration on every replica and every deploy — there is no shared store. All
  replicas must register the **same** catalogue, or two replicas resolve the same
  manifest `id` to different content and replay-by-hash diverges across the fleet.
- Treat the fragment catalogue as **versioned, content-addressed assets**:
  changing a fragment's content without changing its `id` silently breaks replay
  of every historical trace that referenced it (this is the open
  `CryptoReviewer-003` enforcement gap — there is no runtime guard for it yet, so
  it is a **discipline** you must hold).
- For durable replay across deploys, archive the fragment catalogue (content +
  `id`) alongside your trace store, so a trace captured under an old fragment set
  can be reproduced even after the live catalogue moves on.

---

## 5. Redis `SessionLock` — UUID token, Lua release, and heartbeat

The Conductor acquires a per-session lock (`${channel}:${customerId}`) in
`openCapsule` and releases it in `closeCapsule` so same-session turns serialize —
this is what keeps "`adjudicate()` exactly once per turn" true under retries,
multi-tab clients, and multi-replica deploys (see
`packages/core/src/ports/session-lock.ts`). The contract is **multi-process**, so
the production implementation MUST be distributed: a Postgres advisory lock
(`@claustrum/memory-postgres` `PostgresAdvisorySessionLock`) or Redis. If you
implement the `SessionLock` port over Redis, hold these invariants:

- **UUID token.** Store a per-acquire UUID as the lock value (not a constant).
  Release and heartbeat are conditional on that token, so a process whose
  heartbeat lapsed can never act on a lock another agent has since acquired.
- **Lua conditional release.** Never `redis.del()` a lock unconditionally —
  delete only if the value still equals our token, atomically:

  ```lua
  -- KEYS[1] = lock key, ARGV[1] = expected UUID token
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
  ```

  A plain `DEL` lets a stalled holder delete another agent's freshly-acquired
  lock, cascading into the double-`adjudicate()` breach the lock exists to prevent.

- **Heartbeat.** Extend the TTL only while we still own the lock (same
  GET-equals-token guard, then `EXPIRE`). Run the heartbeat at **10s for a 30s
  TTL** — two heartbeats of headroom before expiry. If the holder dies (Node
  crash, container kill), the TTL lapses within ~20s and another agent picks up
  the session; no manual unlock path is needed.

---

## Cross-references

- [`docs/ops/session-and-state-keys.md`](./session-and-state-keys.md) — Redis key
  inventory, agent-lock pattern, `maxmemory-policy` guidance.
- [`docs/ops/defer-troubleshooting.md`](./defer-troubleshooting.md) — DEFER /
  parked-envelope runbook.
- [ADR-005 (Runtime ⇄ Kernel layer split)](../decisions/0005-runtime-kernel-layer-split.md)
  — why client/pool construction is adopter-owned and the kernel boundary is the
  only authoritative surface.
- [`packages/core/src/ports/tenant.ts`](../../packages/core/src/ports/tenant.ts) —
  the `TenantResolver` contract referenced in §3.

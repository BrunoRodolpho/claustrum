# Session, XState, and Agent-Lock Keys

> Runtime-side key inventory extracted from the ibatexas `docs/ops/redis-memory.md` document. The original document covered all Redis keys in the ibatexas adopter — cart, intelligence, payment, rate-limits, metrics, etc. **Cart, intelligence, rate-limit, and adopter-domain keys stay in the ibatexas adopter.** Only the **session, XState snapshot, and agent-lock** keys — the runtime-side patterns any `@claustrum/core`-based adopter needs to operate — migrate to claustrum.

All keys are namespaced with `${APP_ENV}:` via the adopter's `rk()` helper. Example: `production:session:abc123`. The patterns below are the **operational shape** of what a claustrum-based adopter needs to persist for the cognitive loop, the WhatsApp channel adapter, and the agent-locking pattern that serialises per-session work.

The actual key strings (e.g. `wa:agent:{phoneHash}` vs `web:agent:{sessionId}`) are illustrative — claustrum does not mandate the strings, only the access patterns. Adopters implementing `SessionStore`, `ChannelDriver`, and channel-specific locking pick their own namespacing as long as the access patterns are honoured.

---

## Session keys

### `session:{sessionId}` — conversation history list

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `session:{sessionId}` | List | 24-48 h | Chat conversation history (guest 48h, authenticated 24h shorter to expire stale guest carts). **CDC pattern (see [ADR-003](../decisions/0003-conversation-persistence-cdc.md))**: each `appendMessages()` publishes `conversation.message.appended` for durable Postgres archival. Redis is the hot path for the LLM; Postgres is the durable archive. |

Used by:
- `@claustrum/core` cognitive loop — read during the **understand** phase (passed into the `MemorySnapshot`), written during **observe**.
- `SessionStore` implementations — the working-memory frame and recent turns are recomputed from this list during a session's "is stale?" check.

### `session:owner:{sessionId}` — ownership guard

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `session:owner:{sessionId}` | String | 24 h | Maps chat session to owning `customerId` (IDOR / SSE ownership guard). |

Used by channel and route adapters before serving SSE streams or session-resume actions to enforce that the caller is the legitimate owner of the session.

### `session:secret:{sessionId}` — guest hijacking guard

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `session:secret:{sessionId}` | String (UUID) | 1 h | Guest session secret — set on first contact, verified on every guest action. Prevents session hijacking when a guest has no JWT. |

---

## XState snapshot keys (when an adopter layers XState behind claustrum)

When an adopter uses the [hybrid state-flow pattern](../architecture/design/hybrid-state-flow.md) (XState v5 behind a `@claustrum/core`-based conductor), the machine snapshot is persisted in Redis so turn handling can be stateless.

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `{channel}:machine:{sessionId}` | String (JSON) | 24 h | XState machine snapshot — versioned, checksummed, triple-expiry (sliding 30min idle, absolute 4h max, deploy-version mismatch). |

**Persistence handler invariants:**
- The snapshot carries a **schema version**. On load, version mismatch → reset machine.
- The snapshot carries a **SHA-256 checksum**. On load, checksum mismatch → reset machine (treat as corruption).
- Three expiry conditions are checked on every load:
  1. **Sliding** (e.g. 30 min idle) — clears stale conversations.
  2. **Absolute** (e.g. 4h max) — bounds total session lifetime.
  3. **Deploy** — if the machine's source-tree hash changed since the snapshot was taken, the machine code is incompatible — reset.

The state machine itself is **adopter-domain** code. Only the persistence pattern is claustrum-relevant.

---

## Channel-session keys (WhatsApp example)

For the `@claustrum/channel-whatsapp` ChannelDriver — the long-lived session resumption pattern from [the WhatsApp state-builder design](../architecture/design/whatsapp-state-builder.md).

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `wa:phone:{phoneHash}` | Hash | 24 h | WhatsApp session metadata — `phone`, `sessionId`, `customerId`, `lastMessageAt`, `state`. `phoneHash` is `sha256(phone).slice(0,12)` so PII does not appear in keys. |
| `wa:webhook:{MessageSid}` | String | 24 h | WhatsApp webhook idempotency (prevents Twilio retry reprocessing). |
| `wa:debounce:{phoneHash}` | String | 2 s | Message debounce — batches rapid-fire messages from the same sender into one turn. |

For an HTTP/web channel (`@claustrum/channel-web`) the equivalents are keyed by `sessionId` rather than `phoneHash`.

---

## Agent-lock keys (per-session serialisation)

The runtime serialises work per session — concurrent turns for the same session would corrupt the cognitive loop's invariants (one `adjudicate()` per turn, monotonic working-memory updates). The agent lock provides per-session mutual exclusion.

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `wa:agent:{phoneHash}` | String (UUID) | 30 s | WhatsApp agent lock — UUID value, **Lua conditional release**, 10s heartbeat. |
| `web:agent:{sessionId}` | String (UUID) | 30 s | Web chat agent lock — same pattern as WhatsApp, keyed by sessionId. |

**The lock invariant.** Locks use UUID values and Lua conditional release scripts. Never use plain `redis.del()` to release a lock — that allows a process whose heartbeat failed to delete another agent's freshly-acquired lock, creating a cascading breach. Release pattern:

```lua
-- KEYS[1] = lock key, ARGV[1] = expected UUID value
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
```

Heartbeat (extend TTL only if we still own the lock):

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
```

Heartbeat interval should be 10s for a 30s TTL — gives two heartbeats of headroom before TTL expiry. If the heartbeat process dies (Node crash, container kill), TTL expires within ~20s and another agent can pick up the session.

---

## LLM-trace and telemetry keys

| Pattern | Type | TTL | Description |
|---|---|---|---|
| `llm:tokens:{sessionId}` | String (counter) | configurable | Token usage counter per session — backstops runaway model spend. Read by the model-routing layer ([ADR-005](../decisions/0005-runtime-kernel-layer-split.md) §"Cost is three things") to feed the kernel a "current spend" value via envelope context. |

The kernel's cost-cap *enforcement* (REFUSE on budget exceeded) is K-side; the *routing* layer reading this counter to choose Haiku vs. Sonnet is R-side; the *telemetry* of dollars spent per tenant per week is shared platform.

---

## What stays in the adopter

Cart keys (`active:carts`, `cart:nudge:*`, `cart:owner:*`, `cart:create:lock:*`), customer-profile keys (`customer:profile:*`, `customer:pix:*`, `customer:recentlyViewed:*`), intelligence keys (`copurchase:*`, `product:global:score`, `product:reviews:*`, `product:cart:popularity`), search-cache keys (`search_exact:*`, `search_cache:*`, `embedding:query:*`, `query_log:*`), payment keys (`stripe:circuit:*`, `lock:payment:*`, `pix:regen:rate:*`, `retry:*`, `switch:*`, `webhook:processed:*`), rate-limit keys (`otp:*`, `analytics:rate:*`, `ratelimit:customer:create`, `wa:rate:*`, `rate:amend:*`, `rate:cancel:*`, `alert:staff:hourly`), reservation keys (`reminder:sent:*`), review/follow-up keys (`review:prompt:*`, `follow-up:scheduled`), metrics keys (`metrics:*`), DLQ keys (`dlq:*`, `lock:outbox-retry`, `nats:processed:*`), admin dedup keys (`order:status:dedup:*`, `product:update:dedup:*`, `dz:*:dedup:*`), auth keys (`jwt:revoked:*`, `refresh:*`), proactive-outreach keys (`outreach:*`), and schedule cache (`restaurant:schedule`) — all of these are **adopter-domain** concerns. They live in the adopter's docs (for the ibatexas reference adopter: see `docs/ops/redis-memory.md` in `BrunoRodolpho/ibatexas`).

---

## Memory Management Tips (runtime-relevant)

- Redis `maxmemory-policy` should be `allkeys-lru` in production.
- For multi-tenant / staging isolation, the `APP_ENV` prefix prevents key bleed.
- Agent locks use UUID values with Lua conditional release — prevents cascading lock breaches.
- All keys should have TTLs. Long-lived runtime-side keys (anything > 30 days) should be reviewed.

---

## Cross-references

- [ADR-003 (Conversation Persistence CDC)](../decisions/0003-conversation-persistence-cdc.md) — the durable conversation archive pattern that complements the hot Redis path.
- [ADR-002 (Hybrid State-Flow)](../decisions/0002-hybrid-state-flow.md) — the XState pattern these snapshot keys serialise for.
- [`docs/architecture/design/hybrid-state-flow.md`](../architecture/design/hybrid-state-flow.md) — long-form design including snapshot persistence handler details.
- [`docs/architecture/design/whatsapp-state-builder.md`](../architecture/design/whatsapp-state-builder.md) — the WhatsApp `lastCustomerMessageAt` state-projection pattern that uses `wa:phone:{phoneHash}` keys.
- [`docs/ops/defer-troubleshooting.md`](./defer-troubleshooting.md) — DEFER runbook (parked envelopes referenced by `intentHash` flow through session state).
- [`docs/ops/production-readiness.md`](./production-readiness.md) — production tuning for SDK timeouts/retries, connection-pool sizing + `statement_timeout`, the `TenantResolver` per-turn caching contract, and fragment-registry boundedness/replay.

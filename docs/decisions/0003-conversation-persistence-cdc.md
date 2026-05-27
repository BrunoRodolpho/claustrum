# ADR-003: Conversation Persistence via CDC

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #8.
- **Date:** Original decision captured in ibatexas's decisions log alongside the durable-conversation-archive work.

## Context

Conversations (WhatsApp/web) were originally stored only in Redis with 24-48h TTL. There was no durable log for debugging, analytics, or admin visibility. When a turn went wrong in production, the artefacts had typically expired by the time anyone investigated. There was also no way to feed past conversations into offline analysis (cluster-by-refusal, semantic-drift detection, teacher-loop, etc.).

This is a recurring problem for any `@claustrum/core`-based adopter: the cognitive loop produces conversational state that an adopter wants persisted for **a different access pattern** (hot-path turn handling) than for analytical use (durable archive). One store is the wrong answer.

## Decision

Use a **CDC (Change Data Capture)** pattern: the hot-path conversation store (Redis) is the source of truth for turn handling. After each `appendMessages(...)` write to Redis, a message bus event (`conversation.message.appended`) is published. An asynchronous subscriber writes the same conversation to Postgres for durable archival.

- Hot path: Redis (24-48h TTL). Used by the LLM, the prompt composer, the session resumer.
- Durable archive: Postgres. Written best-effort by a subscriber. Queryable via adopter-side CLIs (`ibx chat dump --source postgres`, etc.).
- Transport: NATS Core (no JetStream). No guaranteed delivery; acceptable because the conversation is always in Redis during its TTL — Postgres is best-effort.
- The `appendMessages()` call accepts an optional `meta` parameter (backward-compatible) carrying `customerId` and `channel` so the archiver can index by tenant and channel.

## Consequences

- Postgres becomes queryable for offline analytics, support investigations, and the teacher-loop / auto-curriculum jobs described in [ADR-005 (Runtime/Kernel Layer Split)](./0005-runtime-kernel-layer-split.md).
- If NATS or the subscriber is down, conversations are still served from Redis but the archive lags. This is the intentional failure mode: hot-path availability beats archive completeness.
- Scenario integration tests (11 fixtures at the time of writing the original decision) cover the conversation flows most prone to production regressions.
- In a `@claustrum/core`-based adopter, this pattern is implemented at the adopter layer — claustrum's `SessionStore` port is the interface, and the adopter's `claustrum-bootstrap.ts` wires its preferred Redis + Postgres + NATS implementations. The CDC subscriber is adopter-domain code, not part of `@claustrum/core`.

## Historical files (ibatexas reference adopter, pre-cutover)

- Publisher: `apps/api/src/session/store.ts` (fire-and-forget NATS publish after Redis write)
- Subscriber: `apps/api/src/subscribers/conversation-archiver.ts`
- Domain service: `packages/domain/src/services/conversation.service.ts`
- CLI: `packages/cli/src/commands/chat.ts` (`ibx chat list/dump/clean/scenarios`)
- Tests: `packages/llm-provider/src/__tests__/scenarios/` (11 fixtures)

The `packages/llm-provider/` location is historical (pre-claustrum-cutover). In a claustrum-based adopter the conversation store is wired through `@claustrum/core`'s `SessionStore` port; the scenario tests would live in `@claustrum/conformance` or in the adopter's own integration-test tree.

## Cross-references

- [ADR-005 (Runtime/Kernel Layer Split)](./0005-runtime-kernel-layer-split.md) — durable conversation data is **runtime-owned**, not kernel-owned. The kernel's audit ledger captures the `IntentEnvelope` / `Decision` trail; the conversation archive captures the user-facing dialogue.

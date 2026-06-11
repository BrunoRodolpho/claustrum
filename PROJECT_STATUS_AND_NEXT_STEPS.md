# Project Status & Next Steps

> **Current version:** `@claustrum/core@0.2.0` (rung **v0.2.x — Conformance**). The runtime spine, the 13 frozen plugin ports, and the reference adapters are shipped; the conformance suite is in place. The conversational runtime that orchestrates `@adjudicate/core`.

## Status overview

claustrum is the runtime layer of a three-pillar architecture (`apps → @claustrum/* → @adjudicate/*`). The kernel layer (`@adjudicate/core`) is shipped and stable; the workspace consumes `@adjudicate/core@1.3.0` + `@adjudicate/runtime@0.2.1` from npm (package manifests pin `^1.1.0` / `^0.2.0` as floors — the resolved versions are in `pnpm-lock.yaml`). The runtime is built from scratch on top of the kernel, not extracted from any pre-existing chatbot — deliberately, so the cognitive-loop architecture stands on its own and carries no legacy tangles.

## Maturity ladder

| Layer | Status | What's there |
|---|---|---|
| **Cognitive loop** (`handleTurn`) | shipped | 7-step loop: perceive → understand → plan → submit → act → synthesize → observe, plus two optional gated stages — `[resolve]` (pre-adjudication, read-only) and `[output-firewall]` (post-synthesize). Single `adjudicate()` per turn invariant. |
| **13 plugin ports** | shipped (FROZEN) | `ModelProvider`, `MemoryPort`, `GroundingPort`, `ChannelDriver`, `PlannerPort`, `ResponderPort`, `ExplainerPort`, `HandoffPort`, `SessionPort`, `TelemetryPort`, `Adjudicator`, `FewShotIndex`, `TenantResolver`. Authoritative roster: [`packages/core/src/ports/STATUS.md`](./packages/core/src/ports/STATUS.md). |
| **Post-13 additions** | shipped | `ResolverPort` (`ports/resolver.ts`) — optional pre-adjudication resolve stage. `SessionLock` (`ports/session-lock.ts`) — per-session mutual exclusion (infra, distributed in production). Both are adopter-optional and additive, outside the 13-port freeze. |
| **Reference adapters** | partial | `@claustrum/anthropic`, `@claustrum/openai`, `@claustrum/channel-whatsapp`, `@claustrum/channel-web`, `@claustrum/memory-postgres`, `@claustrum/grounding-pgvector`. |
| **Tooling** | shipped | `@claustrum/cli` — scaffold adopters, replay turns, run the conformance suite. |
| **Conformance suite** | shipped | `@claustrum/conformance` ships invariant tests adopters run. |
| **Examples** | shipped | `examples/minimal-chat` and `examples/healthcare-stub` run end-to-end without ibatexas. |
| **MCP integration** | planned | `@claustrum/mcp-client` (inbound) + `@claustrum/mcp-server` (outbound) are post-MVP. |
| **Multi-agent** | partial | Agents as `PlannerProfile` + `PromptComposer` configs over the same cognitive loop. Cross-process isolation is a future deployment decision. |

> `ToolRegistry` (`packages/core/src/tools/registry.ts`) is tool **infrastructure**, not a port — it is NOT one of the 13 frozen ports. It translates `express_intent`'s capability → tenant-resolved implementation.

## Roadmap to v1.0.0

### v0.1.x — Foundations (done)
- Repo skeleton, CI, parallel specialist-agent build-out
- 13 port interfaces frozen at `@claustrum/core@0.1.0`
- Reference adapters for the dominant providers
- `examples/minimal-chat` runs end-to-end without ibatexas

### v0.2.x — Conformance (current)
- `@claustrum/conformance` invariant tests in place
- `adjudicateOutput` response firewall — optional semantic firewall over outbound drafts; fails CLOSED, does not consume the once-per-turn `adjudicate()` budget (commit `b3239e4`)
- `ResolverPort` pre-adjudication resolve stage — natural-language envelopes → resolved envelopes + per-envelope `SystemState` before the kernel decides (commit `efc011a`)
- `@claustrum/cli` (scaffold / replay / conformance)
- Second adopter example (`healthcare-stub`) ships
- Remaining: few-shot regression-test integration as drift detector; ibatexas cutover

### v0.3.x — MCP integration
- `@claustrum/mcp-client` wraps any MCP server as a `ToolPack`
- `@claustrum/mcp-server` exposes claustrum's capability graph
- Smoke test: Claude Desktop connects, attempts a mutation, gets audit-recorded REFUSE for an unauthorized capability

### v0.4.x — Multi-tenancy
- Tenant policy resolution layer (built on `TenantResolver`)
- Per-tenant fragment registries
- LGPD-grade memory deletion via salt rotation

### v0.5.x — Observability + operator console
- LLM-trace store with separate retention policy
- WebSocket decision stream
- Operator UI for replay + memory inspection

### v0.6.x — Cross-process boundary
- `IntentEnvelope` as wire protocol (ADR-001 published with JSON Schema, canonical hashing, schema-evolution policy)
- NATS / gRPC transports
- Multi-agent broker over IPC
- Distributed `SessionLock` (Postgres advisory / Redis) becomes mandatory once multi-process

### v1.0.0 — API freeze
- Kernel API frozen at `@adjudicate/core` major version
- 13 port interfaces frozen
- Migration guides for each adapter
- Two production adopters

## Pairs with `@adjudicate/core`

Where claustrum is **fast-moving and probabilistic** (memory ranking, prompt synthesis, model routing, planning), adjudicate is **slow-moving and deterministic** (mutation authorization, audit emission, replay-against-historical-policy). The split is intentional: enterprises trust adjudicate; users love claustrum.

See [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate) for the kernel.

## What's open

See the planning artifact at `~/.claude/plans/thaisrodolpho-thaiss-macbook-air-project-lazy-kay.md` for the atomic task graph, gates, risks, and the verification checklist.

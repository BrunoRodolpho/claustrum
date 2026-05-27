# Project Status & Next Steps

> **Current version:** `v0.1.0-experimental` — initial publication, scaffolding the cognitive-loop architecture and the 13 plugin ports.

## Status overview

claustrum is the runtime layer of a three-pillar architecture (`apps → @claustrum/* → @adjudicate/*`). The kernel layer (`@adjudicate/core` v1.1.0+) is shipped and stable. The runtime is built from scratch on top of it — not extracted from any pre-existing chatbot codebase. This is deliberate: it forces the cognitive-loop architecture to stand on its own and avoids carrying forward legacy tangles.

## Maturity ladder

| Layer | Status | What's there |
|---|---|---|
| **Cognitive loop** (`handleTurn`) | shipped | 7-phase loop: perceive → understand → plan → submit → act → synthesize → observe. Single `adjudicate()` per turn invariant. |
| **13 plugin ports** | shipped | `ModelProvider`, `MemoryPort`, `GroundingPort`, `ChannelDriver`, `PlannerPort`, `ResponderPort`, `ExplainerPort`, `HandoffPort`, `SessionPort`, `TelemetryPort`, `ToolRegistry`, `FewShotIndex`, `Adjudicator`. |
| **Reference adapters** | partial | `@claustrum/anthropic`, `@claustrum/openai`, `@claustrum/channel-whatsapp`, `@claustrum/channel-web`, `@claustrum/memory-postgres`, `@claustrum/grounding-pgvector`. |
| **Conformance suite** | initial | `@claustrum/conformance` ships invariant tests adopters can run. |
| **MCP integration** | planned | `@claustrum/mcp-client` (inbound) + `@claustrum/mcp-server` (outbound) are post-MVP. |
| **Multi-agent** | partial | Agents as `PlannerProfile` + `PromptComposer` configs over the same cognitive loop. Cross-process isolation is a future deployment decision. |

## Roadmap to v1.0.0

### v0.1.x — Foundations (current)
- Repo skeleton, CI, 11 specialist agents executing parallel build-out
- 13 port interfaces frozen
- Reference adapters for the 5 dominant providers
- `examples/minimal-chat` runs end-to-end without ibatexas

### v0.2.x — Conformance
- `@claustrum/conformance` invariant tests stable
- Few-shot regression-test integration as drift detector
- Second adopter example (healthcare-stub) ships
- ibatexas cutover completed

### v0.3.x — MCP integration
- `@claustrum/mcp-client` wraps any MCP server as a `ToolPack`
- `@claustrum/mcp-server` exposes claustrum's capability graph
- Smoke test: Claude Desktop connects, attempts a mutation, gets audit-recorded REFUSE for unauthorized capability

### v0.4.x — Multi-tenancy
- Tenant policy resolution layer
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

### v1.0.0 — API freeze
- Kernel API frozen at `@adjudicate/core` major version
- 13 port interfaces frozen
- Migration guides for each adapter
- Two production adopters

## Pairs with `@adjudicate/core`

Where claustrum is **fast-moving and probabilistic** (memory ranking, prompt synthesis, model routing, planning), adjudicate is **slow-moving and deterministic** (mutation authorization, audit emission, replay-against-historical-policy). The split is intentional: enterprises trust adjudicate; users love claustrum.

See [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate) for the kernel.

## What's open

See the planning artifact at `~/.claude/plans/thaisrodolpho-thaiss-macbook-air-project-lazy-kay.md` for the 68-task atomic graph, gates, risks, and the 15-signal verification checklist.

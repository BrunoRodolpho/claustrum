# CLAUDE.md — AI Agent Guide for @claustrum/*

> Read this before writing any code in this repo.

| Need | Go to |
|------|-------|
| Long-form architecture (runtime ⇄ kernel split) | [docs/architecture/design/runtime-kernel-layer-split.md](./docs/architecture/design/runtime-kernel-layer-split.md) |
| Cognitive-loop spec (`handleTurn`) | [docs/architecture/design/cognitive-loop.md](./docs/architecture/design/cognitive-loop.md) |
| Hybrid state-flow / XState pattern | [docs/architecture/design/hybrid-state-flow.md](./docs/architecture/design/hybrid-state-flow.md) |
| Tool classification (READ_ONLY vs MUTATING) | [docs/architecture/design/tool-classification.md](./docs/architecture/design/tool-classification.md) |
| ADRs | [docs/decisions/](./docs/decisions/) |
| Project status, roadmap | [PROJECT_STATUS_AND_NEXT_STEPS.md](./PROJECT_STATUS_AND_NEXT_STEPS.md) |
| Kernel boundary (`@adjudicate/core`) | https://github.com/BrunoRodolpho/adjudicate |

---

## The One Rule

`@claustrum/core` orchestrates; `@adjudicate/core` decides. The runtime may be probabilistic; the kernel must remain deterministic. Every mutation crosses the boundary as an `IntentEnvelope` and returns as a `Decision`. The runtime never mutates state directly.

---

## Hard Rules — Never Break These

1. **LLM Authority (Intent-Gated Execution).** The LLM is a semantic parser with **zero state-mutation authority**. It sees exactly one tool: `express_intent(capability, payload)`. Internal tool ids (`stripe.refund.v2`, `medusa.cart.add`) are **never** exposed to the LLM. The runtime's `ToolRegistry` translates capability → tenant-resolved implementation. Every resolved `IntentEnvelope<kind, payload>` is submitted to `adjudicate()` from `@adjudicate/core/kernel` before any side effect. Every decision is audited via the `Adjudicator` port. There is no env-var gating, no shadow mode, no kill switch on the cognitive loop — the kernel is always authoritative.

2. **`Capsule` is the per-turn handle, NOT `RuntimeContext`.** This is a name-collision hazard worth surfacing explicitly. `@adjudicate/core` exports a type called `RuntimeContext` — that is the **kernel-side per-tenant container** (residency policy, audit sink configuration, multi-tenant boundary). claustrum's per-turn handle is `Capsule` — short-lived, scoped to one conversational turn, contains all ports the cognitive loop needs (`memory`, `grounding`, `planner`, `responder`, `adjudicator`, `session`, `telemetry`, etc.). When reviewing PRs, if you see `ctx.adjudicate(...)` ask: is `ctx` a `Capsule` (runtime) or a `RuntimeContext` (kernel)? They serve different layers; conflating them is a category error.

3. **The cognitive loop is invariant.** `perceive → understand → plan → submit → act → synthesize → observe`. `adjudicate()` is called **exactly once per turn** (or `adjudicatePlan()` for multi-step). The runtime never mutates state without a positive Decision. Every `Decision` variant has a defined handler — `EXECUTE`, `REFUSE`, `DEFER`, `ESCALATE`, `REQUEST_CONFIRMATION`, `REWRITE` — no throws.

4. **The 13 ports are conceptual boundaries, not just types.** Every adapter package implements one or more ports:
   - `ModelProvider` — LLM completion + streaming + embedding
   - `MemoryProvider` — episodic/semantic recall; `recentActions()` reads kernel ledger via `Adjudicator.replayEnvelopesByCustomerId` (NEVER raw SQL into `intent_audit`)
   - `GroundingProvider` — RAG + grounding-proof generation
   - `ChannelDriver` — `perceive`/`render`/`attest`; long-lived session resumption via `matchToParked(channelEvent, session)`
   - `ToolPack` — domain tools exposed by capability
   - `FewShotProvider` — indexed retrieval of conversation exemplars; gold outcomes include expected `Decision`
   - `SessionStore` — persist `Session` across turns, including parked envelopes
   - `TelemetrySink` — `emitTurn`, `emitLLMTrace`, `emitMemoryAccess`; LLM-trace storage is **separate retention** from the audit ledger
   - `PlannerPort` — proposes `IntentEnvelope[]` from `CognitiveState`
   - `ResponderPort` — generates user-facing response
   - `ExplainerPort` — renders refusal text via explain templates
   - `HandoffPort` — human escalation queue
   - `Adjudicator` — the only kernel-facing port

   No adapter depends on another. All depend on `@claustrum/core` for the port type only.

5. **Prompts are content-addressed graphs, not strings.** `PromptComposer` returns `{ system, messages, fewShots, fragmentManifest }`. The `fragmentManifest` is recorded in `LLMTrace` so months later you can replay an exact prompt by hash, even if live fragments have evolved.

6. **The Adjudicator port is the only kernel surface the runtime uses.** Defined at `packages/core/src/ports/adjudicator.ts`. Exposes `adjudicate`, `adjudicatePlan`, optional `adjudicateOutput`, and the read APIs `replayEnvelopesByCustomerId`, `streamAuditByIntentHashPrefix`, `getOutcomes`, `verifyAuditRecord`. The runtime imports **nothing else** from `@adjudicate/core`. If you need additional kernel data, open an issue against adjudicate to expose a stable read API — do not reach into internals.

7. **Tests** — property tests over the cognitive loop must include: "every envelope produced by the planner has `actor.principal` set", "the prompt manifest is included in every LLM trace", "every `EXECUTE` decision triggers exactly one tool invocation", "REFUSE always renders to user-facing text via explain templates", "LLM never sees a tool by its internal id". Iteration counts must be asserted (`N ≥ 100`). The probabilistic-runtime testing strategy is four layers: unit per port, golden conversation snapshots, replay against historical LLM traces, property tests on the loop.

8. **Conformance suite.** `@claustrum/conformance` ships invariant tests adopters must pass. The load-bearing one: "the LLM never sees a tool by its internal id, only by capability." Wire few-shot regression-test integration: re-run all few-shots through current `@claustrum/*` + current `@adjudicate/*`; verify expected decisions still match. This becomes a drift detector for free.

---

## Naming Conventions

| What | Convention | Example |
|------|-----------|---------|
| Types/Interfaces | PascalCase | `Capsule`, `IntentEnvelope`, `Decision` |
| Ports | PascalCase + `Port` suffix | `MemoryPort`, `GroundingPort` |
| Adapters | PascalCase + `Provider` suffix | `AnthropicProvider`, `PgVectorGroundingProvider` |
| Packages | `@claustrum/<kebab>` | `@claustrum/channel-whatsapp` |
| Files | kebab-case | `channel-driver.ts`, `prompt-composer.ts` |

---

## Boundary discipline

- Adapters depend on `@claustrum/core` ports only — never on each other, never on `@adjudicate/core` internals.
- `@claustrum/memory-postgres` is forbidden from raw `intent_audit` SQL — must use `Adjudicator.replayEnvelopesByCustomerId`.
- LLM never sees tool ids — `express_intent(capability, payload)` is the only LLM-facing tool.
- `Capsule` (runtime per-turn) is never conflated with `RuntimeContext` (kernel per-tenant).
- New basis codes are kernel-side additions (`@adjudicate/core` minor version bump), never runtime-side.

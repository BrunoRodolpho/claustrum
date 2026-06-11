# ADR-004: Intent-Gated Execution (IGX) — formerly "Zero-Trust LLM Architecture"

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #9.
- **Date:** Original decision captured in ibatexas's decisions log alongside the governance-kernel extraction. The pattern is the constitutional basis for the `@adjudicate/*` framework and for `@claustrum/core`'s cognitive loop.

## Context

The system originally followed the conventional pattern: the LLM emits tool calls; the runtime executes them. A red-team audit found that the LLM could call mutating tools directly, bypassing business-logic guards. A prompt injection could trigger fraudulent orders. OWASP LLM06 (Excessive Agency) and the OWASP Agentic Top 10 2026 (ASI01/02/03/05) capture the same failure mode.

The fix is to invert the authority relationship: the LLM is a **semantic parser with zero state-mutation authority**. It expresses intent; a deterministic kernel decides what executes.

## Renaming rationale

"Zero-Trust LLM" is industry-overloaded to mean "zero trust in LLM *output*" (content-safety filtering). What this pattern actually does is give the LLM **zero *authority*** — it can be perfectly truthful and still cannot mutate state without going through the kernel. **Intent-Gated Execution (IGX)** is the named research direction we align with for findability.

## Prior art & convergent research (2025–2026)

- **CaMeL** ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813), DeepMind, March 2025) — privileged LLM emits sandboxed DSL; custom interpreter enforces capability-based flow. Closest conceptual match; `IntentEnvelope` + `adjudicate()` is the typed-intent variant of CaMeL's code-sandbox approach.
- **FIDES** ([arXiv 2505.23643](https://arxiv.org/abs/2505.23643), Microsoft, May 2025) — deterministic information-flow control with confidentiality/integrity labels. Inspires the field-level `TaintedValue<T>` roadmap.
- **KAIJU** (arXiv 2604.02375, April 2026) — coins "Intent-Gated Execution (IGX)"; nearly a 1:1 restatement with integer intent tags instead of typed envelopes.
- **OWASP LLM06 (Excessive Agency)** + **OWASP Agentic Top 10 2026 ASI01/02/03/05** — this pattern directly addresses these.

## Decision — defense in depth

The authority inversion is realized by independent mechanisms, not a single classification table.

1. **Single LLM-facing tool surface.** In `@claustrum/core` the LLM literally sees one tool: `express_intent(capability, payload)`. It is advertised a *capability graph* (the capabilities available this turn, by capability id, with descriptions) — never internal tool ids (`stripe.refund.v2`, `medusa.cart.add`). There is **no** `READ_ONLY`/`MUTATING` classification field and no `classification` field on `ToolDefinition`. `ToolDefinition` carries `riskLevel` (`low | medium | high | irreversible`) as an advisory signal for the planner/UX and a policy input — not a runtime branch deciding "is this LLM-callable" (nothing but `express_intent` is). See [tool-classification.md](../architecture/design/tool-classification.md).
2. **Capability visibility (`ToolRegistry`).** `ToolRegistry.resolveCapabilities(ctx)` projects registered tools to `CapabilityDescriptor[]` through the optional `visibility(tools, ctx)` hook, and `descriptorOf` **never copies the internal `id`**. `PromptComposer` (`packages/core/src/prompting/synthesizer.ts`) renders that list. Filtering happens in the registry, not the prompt template, so a template regression cannot leak a hidden capability.
3. **Intent vocabulary.** The LLM's expressed intent becomes a typed `IntentEnvelope<kind, payload>` (`Plan.envelopes`) with `intentHash` and taint; it never calls mutating functions directly. (Read-only enrichment calls are recorded as `Plan.readToolCalls` — no envelope, no kernel round-trip.)
4. **Kernel adjudicator.** Pure function `(envelope, state, policy) → Decision`. The 6-valued `Decision`: `EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE` (`@adjudicate/core` `decision.ts`). A resolved tool's `execute()` runs **only** on `EXECUTE`.
5. **State machine gate.** An adopter that layers a domain state machine (see [ADR-002](./0002-hybrid-state-flow.md)) gates transition legality; the kernel consults it via state guards. This is adopter-domain code.
6. **Taint lattice.** `SYSTEM > TRUSTED > UNTRUSTED` (`@adjudicate/core` `taint.ts`) with `canPropose()` gating per intent kind.
7. **Execution ledger + audit sinks.** Hot-path replay dedup (`intentHash`-keyed) vs. durable governance trail (Console/NATS/Postgres sinks); the two are intentionally distinct.
8. **Structured refusal.** Typed `Refusal` with a `basis.code` drawn from `BASIS_CODES`; first-class output, never an exception.

## Load-bearing invariants

Verified by property tests in `@adjudicate/core`'s invariants tree:

- UNTRUSTED never yields EXECUTE when policy demands TRUSTED+.
- Unknown envelope versions always REFUSE with `schema_version_unsupported`.
- Same `intentHash` submitted twice → second call is a ledger hit; no double execution.
- Every `basis.code` is drawn from `BASIS_CODES` — no free-form strings.
- REWRITE stays in scope (sanitisation / normalisation / safe-capping only; never business transformation).

The claustrum-side backstop is conformance check **CC-001** (`packages/conformance/src/checks/tool-capability-indirection.ts`): "LLM-facing tool surface is exactly `[express_intent]`; internal ids never leak."

## Consequences

- Runtime code (`@claustrum/core`) never mutates state directly. Every mutation crosses into `@adjudicate/core` as an `IntentEnvelope` and returns as a `Decision`. (The adopter-side lint rule forbidding raw Prisma writes outside `withAdjudicate(...)` is the operational form of this invariant — see [ADR-005](./0005-runtime-kernel-layer-split.md).)
- `@adjudicate/*` packages are **domain-independent substrate**; a second-domain scaffold builds without forking the kernel.
- The cognitive loop's **submit** phase (`packages/core/src/handle-turn.ts`) is where the planner-emitted `IntentEnvelope`(s) cross into `@adjudicate/core`. `adjudicate()` (or `adjudicatePlan()` for multi-step) is called **exactly once per turn**.
- System-driven mutations (subscribers, jobs, webhooks) MUST construct a system-actor envelope (`actor.principal = "system"`) — they are not exempt from the kernel.

## Packages

Claustrum consumes the kernel; it does not duplicate it. Versions pinned in `packages/*/package.json`.

- [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/core) (`^1.1.0`) — types + taint lattice + `BASIS_CODES`; `adjudicate()` / `adjudicatePlan()` + `PolicyBundle` + combinators. Its optional `@adjudicate/core/llm` subpath ships a generic LLM-side toolkit (`CapabilityPlanner`, `ToolClassification`/`isReadOnly`/`filterReadOnly`, `PromptRenderer`). **`@claustrum/core` does not use that subpath** — it realizes the LLM-facing surface with its own runtime `ToolRegistry` + `PromptComposer` instead.
- [`@adjudicate/runtime`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/runtime) (`^0.2.0`) — `resumeDeferredIntent` + `deadlinePromise` for orchestrators. Consumed by `@claustrum/core`.
- [`@adjudicate/audit`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/audit) — ledger + audit sinks + replay.
- [`@adjudicate/audit-postgres`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/audit-postgres) — reference Postgres sink.

## Historical files (ibatexas adopter, pre-cutover)

The pre-cutover implementation lived in the ibatexas monorepo at `packages/llm-provider/`. The classification constants, intent bridge, state gate, machine, and kernel-executor files were deleted in the claustrum cutover. The equivalents in `@claustrum/core`:

| Original ibatexas file (pre-cutover) | Claustrum equivalent |
|---|---|
| `packages/llm-provider/src/machine/types.ts` (`TOOL_CLASSIFICATION`) | `ToolRegistry` capability/id indirection + `ToolDefinition.riskLevel`; the single `express_intent` surface enforced by CC-001 (`@claustrum/core` has no `classification` field) |
| `packages/llm-provider/src/tool-registry.ts` (intent bridge) | `ToolRegistry.resolveTool` (post-`EXECUTE`) + cognitive-loop `submit` phase |
| `packages/llm-provider/src/llm-responder.ts` (`processToolCalls`) | cognitive loop (`handleTurn`) — Decision dispatch matrix |
| `packages/llm-provider/src/machine/order-machine.ts` (post_order sub-states) | adopter-domain `ToolPack` + XState machine (not part of `@claustrum/core`) |
| `packages/llm-provider/src/kernel-executor.ts` (cancel/amend/pix handlers) | adopter-domain `ToolPack`; the kernel still sees only `IntentEnvelope` |

## Feature flags

There is **no** env-var gating of the cognitive loop in claustrum-based adopters: the kernel is unconditionally in the path (per [ADR-005](./0005-runtime-kernel-layer-split.md), no shadow mode, no kill switch). The historical ibatexas rollout flags (`IBX_LEDGER_ENABLED`, `IBX_LEDGER_ENFORCE`) are retired.

## Cross-references

- [tool-classification.md](../architecture/design/tool-classification.md) — runtime-side `ToolRegistry` / `riskLevel` / capability-resolution mechanics and CC-001.
- [ADR-002 (Hybrid State-Flow)](./0002-hybrid-state-flow.md) — the XState surface an adopter's state-aware `visibility` hook plugs into.
- [ADR-005 (Runtime/Kernel Layer Split)](./0005-runtime-kernel-layer-split.md) — declares what the kernel is *not*, keeping this ADR's authority inversion clean across layers.
- `@adjudicate/core` source: [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate).

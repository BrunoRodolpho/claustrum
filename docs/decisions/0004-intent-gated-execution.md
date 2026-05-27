# ADR-004: Intent-Gated Execution (IGX) — formerly "Zero-Trust LLM Architecture"

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #9.
- **Date:** Original decision captured in ibatexas's decisions log alongside the v1.0 governance kernel extraction. The pattern is the constitutional basis for the `@adjudicate/*` framework (v1.0 of which shipped before the claustrum runtime was extracted) and for `@claustrum/core`'s cognitive loop.

## Context

The system originally followed the conventional pattern: the LLM emits tool calls; the runtime executes them. A red-team audit found that the LLM could call mutating tools directly, bypassing business-logic guards. A prompt injection could trigger fraudulent orders. The OWASP LLM06 (Excessive Agency) and the OWASP Agentic Top 10 2026 (ASI01/02/03/05) capture the same failure mode.

The fix is to invert the authority relationship: the LLM is a **semantic parser with zero state-mutation authority**. It expresses intent; a deterministic kernel decides what executes.

## Renaming rationale

"Zero-Trust LLM" is industry-overloaded to mean "zero trust in LLM *output*" (content-safety filtering). What this pattern actually does is give the LLM **zero *authority*** — it can be perfectly truthful and still cannot mutate state without going through the kernel. **Intent-Gated Execution (IGX, KAIJU 2026)** is the named research direction we align with for findability.

## Prior art & convergent research (2025–2026)

- **CaMeL** ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813), DeepMind, March 2025) — privileged LLM emits sandboxed DSL; custom interpreter enforces capability-based flow. Closest conceptual match; `IntentEnvelope` + `adjudicate()` is the typed-intent variant of CaMeL's code-sandbox approach.
- **FIDES** ([arXiv 2505.23643](https://arxiv.org/abs/2505.23643), Microsoft, May 2025) — deterministic information-flow control with confidentiality/integrity labels. Inspires the v1.1 field-level `TaintedValue<T>` roadmap.
- **KAIJU** (arXiv 2604.02375, April 2026) — coins "Intent-Gated Execution (IGX)". Nearly a 1:1 restatement with integer intent tags instead of typed envelopes.
- **Microsoft Agent Governance Toolkit** (open-sourced April 2026) — GovernanceKernel is the closest commercial analog; same split, policy-as-data instead of typed-intent vocabulary.
- **OWASP LLM06 (Excessive Agency)** + **OWASP Agentic Top 10 2026 ASI01/02/03/05** — this pattern directly addresses these.

## Decision — 8-layer defense (IGX v1.0)

1. **Tool Classification.** Type-enforced READ_ONLY vs MUTATING partition. The runtime's `ToolRegistry` knows the classification; the LLM-facing surface only ever exposes the safe partition.
2. **Prompt Synthesizer / Capability Planner.** Structurally filters MUTATING tools from the LLM's visible tool list (security-sensitive, separated from cosmetic prompt rendering).
3. **Intent Vocabulary.** The LLM emits typed `IntentEnvelope<kind, payload>` with `intentHash` and taint; never calls mutating functions directly. In `@claustrum/core` the LLM literally sees one tool: `express_intent(capability, payload)`. The runtime translates capability → tenant-resolved implementation; internal tool ids are never exposed.
4. **Kernel Adjudicator.** Pure function `(envelope, state, policy) → Decision`. The 6-valued `Decision`: `EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE`.
5. **State Machine Gate.** A domain state machine (e.g. XState — see [ADR-002](./0002-hybrid-state-flow.md)) decides transition legality; the kernel consults it via state guards.
6. **Taint Lattice.** `SYSTEM > TRUSTED > UNTRUSTED` with `canPropose()` gating per intent kind.
7. **Execution Ledger + Audit Sinks.** Hot-path replay dedup (Redis, `intentHash`-keyed) vs. durable governance trail (Console/NATS/Postgres sinks); the two are intentionally distinct.
8. **Structured Refusal.** Stratified taxonomy `SECURITY | BUSINESS_RULE | AUTH | STATE`; first-class output, never an exception.

## Load-bearing invariants

Verified by property tests in `@adjudicate/core/kernel`'s invariants test tree:

- UNTRUSTED never yields EXECUTE when policy demands TRUSTED+.
- Unknown envelope versions always REFUSE with `schema_version_unsupported`.
- Same `intentHash` submitted twice → second call returns LedgerHit; no double execution.
- Every `basis.code` is drawn from `BASIS_CODES[category]` — no free-form strings.
- REWRITE stays in scope (sanitisation / normalisation / safe-capping only; never business transformation).

## Consequences

- Runtime code (`@claustrum/core`) never mutates state directly. Every mutation goes through `adjudicate()`. The lint rule that forbids raw Prisma writes outside `withAdjudicate(...)` is the operational form of this invariant in adopters.
- `@adjudicate/*` packages are **domain-independent substrate**; a second-domain scaffold (e.g. a clinic-scheduling adopter) builds in under a day without forking.
- The claustrum cognitive loop's `submit` phase is the dedicated step where the planner-emitted `IntentEnvelope`(s) cross into `@adjudicate/core`. There is exactly one `adjudicate()` (or `adjudicatePlan()`) call per turn.
- System-driven mutations (subscribers, jobs, webhooks) MUST construct a system-actor envelope (`actor.principal = "system"`) — they are not exempt from the kernel.

## Packages

- [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/core) — types + lattice + `BASIS_CODES`; `adjudicate()` + `PolicyBundle` + combinators; `CapabilityPlanner` + `ToolClassification` + `PromptRenderer`.
- [`@adjudicate/audit`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/audit) — ledger + audit sinks + replay.
- [`@adjudicate/audit-postgres`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/audit-postgres) — reference Postgres sink.
- [`@adjudicate/runtime`](https://github.com/BrunoRodolpho/adjudicate/tree/main/packages/runtime) — `resumeDeferredIntent` + `deadlinePromise` for orchestrators. Consumed by `@claustrum/core`, not duplicated.

## Historical files (ibatexas adopter, pre-cutover)

The v1.0 implementation lived in the ibatexas monorepo at `packages/llm-provider/`. The classification constants, intent bridge, state gate, machine, and kernel-executor files referenced in the original decision were deleted in the claustrum cutover. The equivalent in `@claustrum/core`:

| Original ibatexas file (pre-cutover) | Claustrum equivalent |
|---|---|
| `packages/llm-provider/src/machine/types.ts` (`TOOL_CLASSIFICATION`) | `@claustrum/core` `ToolRegistry` + `ToolDefinition.classification` |
| `packages/llm-provider/src/tool-registry.ts` (intent bridge) | `@claustrum/core` `ToolRegistry.resolveTool` + cognitive-loop `submit` phase |
| `packages/llm-provider/src/llm-responder.ts` (`processToolCalls`) | `@claustrum/core` cognitive loop (`handleTurn`) — Decision dispatch matrix |
| `packages/llm-provider/src/machine/order-machine.ts` (post_order sub-states) | Adopter-domain `ToolPack` + XState machine (not part of `@claustrum/core`) |
| `packages/llm-provider/src/kernel-executor.ts` (cancel/amend/pix handlers) | Adopter-domain `ToolPack`; the kernel still sees only `IntentEnvelope` |

## Feature flags

In ibatexas these were the rollout flags; in claustrum the kernel is unconditionally in the path (per [ADR-005 (Runtime/Kernel Layer Split)](./0005-runtime-kernel-layer-split.md) and the kernel-always-on cutover in ibatexas — there is no env-var gating in claustrum-based adopters):

- `IBX_LEDGER_ENABLED=true` (historical) — shadow writes to the execution ledger.
- `IBX_LEDGER_ENFORCE=true` (historical) — ledger authoritative on the write path (dedup enforced).

## Cross-references

- [ADR-002 (Hybrid State-Flow)](./0002-hybrid-state-flow.md) — the XState surface this ADR's tool-classification gate plugs into.
- [ADR-005 (Runtime/Kernel Layer Split)](./0005-runtime-kernel-layer-split.md) — declares what the kernel is *not* (no embeddings, no memory, no prompts) so this ADR's authority inversion stays clean across layers.
- [`docs/architecture/design/runtime-kernel-layer-split.md`](../architecture/design/runtime-kernel-layer-split.md) — long-form spec of the layer boundary.
- `@adjudicate/core` source: [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate).

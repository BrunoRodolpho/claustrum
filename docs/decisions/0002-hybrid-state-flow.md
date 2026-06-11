# ADR-002: Hybrid State-Flow Architecture

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #7, then generalised for claustrum.
- **Date:** Original decision predates the claustrum extraction. Captured in ibatexas's decisions log alongside the WhatsApp/web chatbot redesign.
- **Long-form design:** [`docs/architecture/design/hybrid-state-flow.md`](../architecture/design/hybrid-state-flow.md)

## Context

A conversational adopter built on `@claustrum/core` is exposed to a class of failures that arise when business rules are expressed solely through a monolithic LLM prompt: the LLM hallucinates rules (asks logged-in users to log in, ignores time-based availability, uses unauthorised tones), the prompt grows unbounded, and there is no deterministic gate on what the system is permitted to *do* in response to a turn.

The reference case is the ibatexas commerce adopter, whose WhatsApp bot was originally driven by a 3,400-token monolithic prompt that re-stated every rule on every turn — the LLM was both the natural-language surface and the business-policy authority. The historical ibatexas prototype eliminated this by layering a deterministic **XState v5** machine behind the LLM. **claustrum itself uses no XState** (zero dependency); the deterministic gate is provided by the kernel (`adjudicate()`) and the planner/registry seam, of which the XState machine was one app-domain implementation.

## Decision

Keep business decisions out of the probabilistic surface. The LLM is a semantic parser only; a deterministic stage decides and executes. In claustrum this is realised by three `@claustrum/core` seams:

1. **`PlannerPort`** — proposes `IntentEnvelope[]` from `CognitiveState`. An adopter is free to back it with any deterministic engine (a state machine, rules, or a classifier).
2. **`adjudicate()`** (the `Adjudicator` port) — the once-per-turn deterministic gate. No mutation happens without a positive `Decision`. This is the contract that replaces the historical machine-as-authority design.
3. **`ToolRegistry` + `PromptComposer`** — the LLM sees only `express_intent(capability, payload)`; the registry translates capability → tenant-resolved implementation, and the composer synthesises a small per-turn prompt. Mutating tool ids are never exposed to the LLM.

### Historical ibatexas reference (XState)

The original prototype expressed the deterministic stage as a four-stage pipeline. Retained for context; **none of this is claustrum code**:

1. **Router** — keyword regex (and optional fuzzy classifier) extracts structured events from the inbound message. No LLM cost.
2. **State Machine (XState v5)** — processes events with guards, executes side effects (tool calls) as actions.
3. **Prompt Synthesizer** — maps machine state to a tiny prompt (~200-400 tokens).
4. **Response Agent (LLM)** — generates natural language only; no business decisions, no mutating tool calls.

## Key design points

- Mutating tools are **never exposed to the LLM**. The deterministic stage (machine / planner) drives them; the LLM sees only `express_intent` and read-only capabilities. In claustrum this invariant is enforced by `ToolRegistry` and proved by the conformance check `tool-capability-indirection`.
- *(Historical ibatexas)* The XState snapshot was persisted to Redis (`wa:machine:{sessionId}`, 24h TTL) for stateless turn handling. claustrum has no such key; cross-turn state is carried by `SessionPort`.
- *(Historical ibatexas)* Guards were deterministic — e.g. `isAvailableNow`, `isAuthenticated`, `isInDeliveryZone`. These were app-domain order-machine guards and do not exist in claustrum; the equivalent in claustrum is a domain guard evaluated inside `adjudicate()` against per-envelope `SystemState`.
- Token reduction: 3,400 → ~400 tokens/turn (88% savings) in the ibatexas reference implementation.

## Consequences

- The cognitive loop in `@claustrum/core` (`perceive → understand → plan → [resolve] → submit → act → synthesize → [output-firewall] → observe`) is compatible with this pattern: the deterministic planner substitutes for a naive "ask the LLM what to do." Its events become `IntentEnvelope`s submitted to `adjudicate()`.
- Adopters wanting the full hybrid pattern implement their deterministic stage on top of `@claustrum/core`'s `PlannerPort`, `PromptComposer`, and `ToolRegistry`. The decision engine itself (whether an XState machine or otherwise) remains app-domain — it is not part of `@claustrum/core`.
- Wiring convention: an adopter registers domain capabilities via `createToolRegistry()` and composes per-turn prompts via `createPromptComposer()` (both exported from `@claustrum/core`), assembling them into the per-turn `Capsule`. The historical ibatexas machine (`packages/llm-provider/src/machine/order-machine.ts`) and synthesizer (`packages/llm-provider/src/prompt-synthesizer.ts`) were deleted in the claustrum cutover.

## Cross-references

- [ADR-004 (Intent-Gated Execution)](./0004-intent-gated-execution.md) — formalises the LLM-has-zero-mutation-authority invariant this ADR depends on.
- [`docs/architecture/design/hybrid-state-flow.md`](../architecture/design/hybrid-state-flow.md) — long-form design and 10-layer pipeline (historical ibatexas reference).

# ADR-002: Hybrid State-Flow Architecture (XState)

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #7.
- **Date:** Original decision predates the claustrum extraction. Captured in ibatexas's decisions log alongside the WhatsApp/web chatbot redesign.
- **Long-form design:** [`docs/architecture/design/hybrid-state-flow.md`](../architecture/design/hybrid-state-flow.md)

## Context

A conversational adopter built on `@claustrum/core` is exposed to a class of failures that arise when business rules are expressed solely through a monolithic LLM prompt: the LLM hallucinates rules (asks logged-in users to log in, ignores time-based availability, uses unauthorised tones), the prompt grows unbounded, and there is no deterministic gate on what the system is permitted to *do* in response to a turn.

In the ibatexas commerce adopter, the WhatsApp bot was originally driven by a 3,400-token monolithic prompt that re-stated every rule on every turn. The LLM was both the natural-language surface and the business-policy authority. Moving business logic into a deterministic state machine eliminates the hallucination class entirely.

## Decision

Layer a deterministic **XState v5** machine behind a probabilistic LLM-driven natural-language surface, with a four-stage pipeline:

1. **Router** — keyword regex (and optional fuzzy classifier) extracts structured events from the inbound message. No LLM cost.
2. **State Machine (XState)** — processes events with guards, executes side effects (tool calls) as actions.
3. **Prompt Synthesizer** — maps the current machine state to a tiny prompt (~200-400 tokens) describing only what the LLM needs for this turn.
4. **Response Agent (LLM)** — generates natural language only. No business decisions; no direct tool calls for mutating capabilities.

## Key design points

- Mutating tools are **never exposed to the LLM**. The state machine calls them as side effects; the LLM sees only read-only capabilities (or none at all in checkout-like flows).
- XState snapshot is persisted to Redis (`wa:machine:{sessionId}`, 24h TTL by default) for stateless turn handling.
- Guards are deterministic: `isAvailableNow`, `isAuthenticated`, `isInDeliveryZone`, etc.
- Token reduction: 3,400 → ~400 tokens/turn (88% savings) in the ibatexas reference implementation.

## Consequences

- The cognitive loop in `@claustrum/core` (`perceive → understand → plan → submit → act → synthesize → observe`) is compatible with this pattern: the planner-and-state-machine substitutes for a naive "ask the LLM what to do." The state-machine-driven events become `IntentEnvelope`s submitted to `adjudicate()`.
- Adopters that want this pattern should implement the four pipeline stages on top of `@claustrum/core`'s `PromptComposer`, `PlannerPort`, and a custom XState-backed adapter (the machine itself remains app-domain — it's not part of `@claustrum/core`).
- For the historical ibatexas implementation, the machine definition lived at `packages/llm-provider/src/machine/order-machine.ts` and the synthesizer at `packages/llm-provider/src/prompt-synthesizer.ts`. That package was deleted in the claustrum cutover; the equivalent in a claustrum-based adopter is a `ToolPack` + `PromptComposer` registration in the adopter's `claustrum-bootstrap.ts`.

## Cross-references

- [ADR-004 (Intent-Gated Execution)](./0004-intent-gated-execution.md) — formalises the LLM-has-zero-mutation-authority invariant this ADR depends on.
- [`docs/architecture/design/hybrid-state-flow.md`](../architecture/design/hybrid-state-flow.md) — long-form design and 10-layer pipeline.
- Historical: ibatexas `packages/llm-provider/src/machine/` (pre-cutover, deleted).

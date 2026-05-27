# Agent Context Ranking Pattern

> Runtime-side pattern extracted from the ibatexas `docs/architecture/design/customer-intelligence.md` document. The original document combined the runtime ranking mechanism (this file) with the ibatexas-specific analytics event catalogue, PostHog dashboards, and owner-dashboard wireframes. **The analytics schema stays in the ibatexas adopter.** Only the agent context ranking pattern — generalised away from the ibatexas commerce schema — migrates to claustrum as a runtime-side design pattern.

A `@claustrum/core`-based adopter typically maintains a per-customer (or per-actor) profile — preferences, last activity, behaviour signals — and uses it to:

1. **Bias retrieval and recommendations** the LLM presents to the user.
2. **Filter** items the LLM may consider (e.g. allergen exclusions, regional restrictions).
3. **Personalise** natural-language framing ("seu pedido de sempre?", "como sempre, mesa interna?").

The way claustrum thinks about this is straightforward: the profile is **runtime-owned data** (read through the `MemoryPort`'s semantic-recall surface), the ranking rules are **runtime-owned policy**, and the explanations are **runtime-owned prompts**. The kernel sees only the resulting `IntentEnvelope`s that actually mutate state.

---

## The Profile abstraction

The runtime maintains a typed profile per customer (or actor). Concrete fields are adopter-domain; the shape that matters at the `@claustrum/core` boundary is:

```typescript
interface ActorProfile {
  // Soft preferences: settable by the user, suggestable by the agent (with confirmation)
  preferences: Record<string, unknown>;

  // Hard filters: only ever set explicitly by the user. Never inferred.
  // Safety-critical exclusions (allergens, regional restrictions, disability accommodations) belong here.
  hardFilters: Record<string, unknown>;

  // Behavioural signals: computed from history
  recentActivity: ActivitySummary;
  patterns: BehaviourPatterns;
  lastAction: { kind: string; at: Date; payload: unknown } | null;
}
```

**Hard rule.** Soft preferences are inferred-and-confirmed. Hard filters are user-set only. A false negative on a hard filter is dangerous (the food-allergen case is the canonical example, but the same logic applies to accessibility, residency, and regulatory exclusions in other domains). Conformance: an adopter's hard-filter exclusions are surfaced *before* the LLM ranks anything — by `CapabilityPlanner` if the filter affects visibility, or by the recall layer if it affects retrieval candidates.

The profile is populated from:
- **Explicit user input** via tool calls (e.g. `update_preferences`).
- **Inferred patterns** that the agent surfaces and the user confirms ("noticed you usually prefer X — should I filter by that?").
- **Domain events** the adopter publishes (order completed, reservation no-show, etc.) — flowing into the profile via the `MemoryPort.observe(...)` write path.

---

## The ranking-with-reasons pattern

When the agent needs to present a ranked list (recommendations, suggestions, options), it uses a **rule-based priority sort with explainable reasons** rather than a free-text LLM ranking. The LLM does not have license to invent rankings; it phrases the result.

Pattern:

```typescript
interface RankedCandidate<T> {
  item: T;
  reason: ReasonCode;        // closed vocabulary
  reasonText: string;        // user-facing, localised
  score: number;             // for stable sort
}
```

**Priority rules** are ordered. The first matching rule wins:

1. **Direct match against profile favourites / hard preferences** — items the user has explicitly favoured that satisfy hard filters and current availability.
2. **Pattern match** — current time / context matches a recurring user pattern (e.g. "usually orders around 7pm" → offer the usual at 7pm-ish).
3. **Cross-context** — items related to current session context (cart contents, conversation topic, in-flight reservation).
4. **Trending / popular in the current window** — adopter-domain heuristic.
5. **Quality fallback** — top-rated / most-reliable when none of the above fires.

**Hard filters** are applied **before** ranking. Candidates excluded by hard filter never see the priority pass. Examples of hard filters:
- Out of stock / unavailable.
- Outside availability window (time-of-day, day-of-week).
- Matches a `hardFilters` exclusion (allergens, regional restrictions, regulatory blocks).
- Already in the current selection (don't recommend what the user already chose).

**Reason codes** are a closed vocabulary. The user-facing `reasonText` is a translation of the code in the adopter's localisation tree. Never a free-text LLM-generated explanation — that opens the door to hallucinated justifications.

---

## Where this lives in the claustrum cognitive loop

The `ActorProfile` is loaded during the **understand** phase via `MemoryPort.recall(customerId, perception)`. The recalled `MemorySnapshot` carries the profile alongside relevant past turns.

Ranking happens in the **plan** phase, before the LLM is asked to phrase a response. The `PlannerPort` builds the `RankedCandidate<T>[]` (using adopter-domain rules) and either:
- Emits an `IntentEnvelope` referencing the chosen action (if the plan is to act on the ranked output), or
- Passes the ranked list to the `ResponderPort` to phrase as natural language (read-only presentation).

The LLM in the **synthesize** phase receives the ranked list as a structured input fragment in the prompt; its job is to phrase, not to re-rank. The `PromptComposer` records the fragment manifest so months later a regression in ranking can be traced to the exact ranked input that was given to the LLM.

---

## What stays in the adopter

The concrete rule set ("favourites first, then reorder, then cross-sell, then trending, then top-rated"), the reason vocabulary, the profile field set, the localised reason texts, the analytics event catalogue, and the dashboards built on top of them are **adopter-domain code and configuration**. claustrum provides:

- `MemoryPort` — the recall surface for the profile.
- `PlannerPort` — the interface the ranking rules plug into.
- `PromptComposer` — the fragment registry that makes ranked inputs replayable.

For the historical ibatexas analytics catalogue (NATS event names, PostHog dashboards, owner-dashboard wireframes), see the ibatexas-side `docs/architecture/design/customer-intelligence.md` and `docs/ops/analytics-dashboards.md`. Those documents are intentionally **not migrated to claustrum** — they are adopter-specific schema.

---

## Cross-references

- [`docs/architecture/design/runtime-kernel-layer-split.md`](./runtime-kernel-layer-split.md) — why the profile is runtime-owned (it is hot-path conversational context; the kernel's audit ledger captures *what was done*, not *what was preferred*).
- [`docs/ops/session-and-state-keys.md`](../../ops/session-and-state-keys.md) — runtime-side session/state keys including profile cache keys.
- [ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md) — the agent's ranked output is still subject to capability classification; mutations flow through `adjudicate()`.
- `@claustrum/core` `MemoryPort`, `PlannerPort`, `PromptComposer` types.

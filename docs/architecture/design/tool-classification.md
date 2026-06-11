# Tool Classification (`riskLevel`) & Capability Resolution

> Runtime-side mechanism extracted from the ibatexas `docs/architecture/design/agent-tools.md` document. That original combined this mechanism with the ibatexas-domain tool catalog. **The tool catalog stays in the ibatexas adopter.** Only the runtime-side pattern any `@claustrum/core`-based adopter needs migrates here.

The runtime exposes capabilities to the LLM via a single tool surface, `express_intent(capability, payload)`. Tool *identity* — which concrete implementation handles a capability, what its internal `id` is, how risky it is — is hidden from the LLM. This document describes the machinery that makes that hiding load-bearing rather than cosmetic.

This is the runtime-side operationalisation of [ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md). The constitutional declaration ("LLM has zero state-mutation authority") is realised in code through (1) the `express_intent` capability indirection, (2) per-context capability visibility, and (3) kernel adjudication of every resolved envelope.

---

## What the LLM sees: exactly `express_intent`

There is **no** static `READ_ONLY` / `MUTATING` partition and no `classification` field on `ToolDefinition`. The LLM is not given any tool by its internal id, and it does **not** invoke tools directly. Per conformance check **CC-001**, the LLM-facing tool surface is exactly `[express_intent]`.

The LLM is advertised a *capability graph* (which capabilities exist this turn, with descriptions) on the plan-side prompt, and expresses what it wants via `express_intent(capability, payload)`. The runtime then:

- For **read-only enrichment**, records the LLM's tool calls as `Plan.readToolCalls` (`packages/core/src/ports/planner.ts:53-57`) — `{ name, input }[]`, no envelope, no kernel round-trip.
- For **mutations**, translates the expressed intent into an `IntentEnvelope<kind, payload>` (`Plan.envelopes`) and submits it to `adjudicate()`. The kernel's `Decision` governs whether the resolved tool's `execute()` runs.

---

## `riskLevel`, not `classification`

Every tool carries a `riskLevel` (`packages/core/src/tools/types.ts:115`), surfaced on the `CapabilityDescriptor` (`types.ts:86`):

```typescript
readonly riskLevel: "low" | "medium" | "high" | "irreversible";
```

It is a **required** field on `ToolDefinition`. Adopters also declare the optional `requiresConfirmation?: boolean` (`types.ts:119`). These are advisory signals for the planner/UX and inputs the kernel can policy on — they are *not* a runtime branch that decides "can the LLM call this directly" (nothing is LLM-callable but `express_intent`).

---

## Capability resolution (`ToolRegistry`)

`@claustrum/core`'s `ToolRegistry` (`packages/core/src/tools/registry.ts`) is the runtime component that holds tools and produces the LLM-visible capability list. There is **no** `CapabilityPlanner` component.

It indexes tools two ways (`registry.ts:84-88`):

- `byId: Map<string, ToolDefinition>` — internal id → implementation.
- `byCapability: Map<CapabilityId, ToolDefinition[]>` — capability → candidate implementations.

Two read paths:

- **`resolveCapabilities(ctx)`** (`registry.ts:150-163`) → `CapabilityDescriptor[]`. Filters the registered tools through the optional `visibility(tools, ctx)` hook (`registry.ts:65-68`, default: all tools), de-dupes by capability, and projects each to a descriptor via `descriptorOf` — which copies `capability`, `intentKind`, `description`, `riskLevel`, and the optional `requiresConfirmation`/`groundingRequirements`, but **never** the internal `id`. This is the list the planner advertises to the LLM; `PromptComposer` (`packages/core/src/prompting/synthesizer.ts`) renders it into the prompt.
- **`resolveTool(capability, ctx)`** (`registry.ts:170-183`) → `ToolDefinition`. Run AFTER a Decision returns `EXECUTE`. Picks among candidates via the optional `chooseImplementation(candidates, ctx)` hook (default: last-registered wins), so two tools may share a capability and discriminate by tenant.

The `visibility` hook is the right place to enforce per-tenant policy ("this tenant has not paid for the loyalty tier, hide loyalty capabilities"). Because filtering happens **here**, not in the prompt template, a template regression cannot accidentally leak a hidden capability.

> **Not yet implemented:** there is no per-`MachineState` `allowedCapabilities` table and no state-gated visibility in `src`. An adopter that wants state-gated visibility implements it *inside* its own `visibility(tools, ctx)` hook by inspecting machine state on `ctx`; `@claustrum/core` ships only the generic hook, not a state-machine-aware one.

---

## Defense in depth

The constitutional zero-authority invariant rests on three independent mechanisms, not a single classification table:

1. **Capability indirection (`express_intent`).** The LLM's only tool is `express_intent(capability, payload)`. It sees a closed vocabulary of *capability* ids — never internal tool ids (`stripe.refund.v2`, `medusa.cart.add`). Enforced structurally by `CapabilityDescriptor` omitting `id`, and verified by CC-001 (below).
2. **Kernel adjudication.** Every resolved mutation envelope is submitted to `adjudicate()`; the tool's `execute()` runs **only** on an `EXECUTE` Decision. `riskLevel` / `requiresConfirmation` are inputs to that policy and to confirmation UX (a `REQUEST_CONFIRMATION` decision).
3. **Adopter domain guards.** When an adopter layers a deterministic state machine behind the LLM (see [ADR-002 (Hybrid State-Flow)](../../decisions/0002-hybrid-state-flow.md)), guarded transitions (e.g. `canCancelOrder`, `hasOrderId`) are the final gate on legality even after an `EXECUTE` returns. This is adopter-domain code.

---

## CC-001 — the load-bearing conformance check

`@claustrum/conformance` ships **CC-001** (`packages/conformance/src/checks/tool-capability-indirection.ts`), named:

> "LLM-facing tool surface is exactly [express_intent]; internal ids never leak"

It opens a `Capsule`, reads `capsule.tools.resolveCapabilities(capsule)`, and asserts no descriptor carries an `id` field and that no internal tool `id` (when it differs from its capability) appears in the descriptor list. It passes vacuously when no tools are registered. The invariant is enforced by the `ToolRegistry` type itself (`descriptorOf` never copies `.id`); CC-001 is the paranoid backstop against an adopter subclassing the registry in a way that leaks.

---

## What stays in the adopter

The concrete tool catalog — the actual `search_products`, `add_to_cart`, `create_reservation`, etc. — is **adopter-domain code**, registered with the `ToolRegistry` from the adopter's bootstrap. Each `ToolDefinition` (`packages/core/src/tools/types.ts:96-128`) declares `id`, `capability`, `description`, `inputSchema`, `outputSchema`, `intentKind`, `riskLevel`, the optional guards (`allowedChannels`, `allowedRoles`, `requiresConfirmation`, `groundingRequirements`), and `execute(input, ctx)`.

For the historical ibatexas catalog (~25 tools across Catalog, Commerce, Reservation, Intelligence, Support, Loyalty), see the ibatexas-side `docs/architecture/design/agent-tools.md`, which remains the canonical catalog reference.

---

## Cross-references

- [ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md) — the constitutional basis for this mechanism.
- [ADR-002 (Hybrid State-Flow)](../../decisions/0002-hybrid-state-flow.md) — where an adopter's state-aware `visibility` hook plugs in.
- [`runtime-kernel-layer-split.md`](./runtime-kernel-layer-split.md) — why capability resolution is runtime-side (about *what the LLM sees*), while permission to execute is kernel-side.
- `packages/core/src/tools/{types.ts,registry.ts}` — `ToolDefinition`, `CapabilityDescriptor`, `ToolRegistry`.
- `packages/conformance/src/checks/tool-capability-indirection.ts` — CC-001.

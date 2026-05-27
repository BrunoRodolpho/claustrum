# Tool Classification (READ_ONLY vs MUTATING) & Capability Planning

> Runtime-side mechanism extracted from the ibatexas `docs/architecture/design/agent-tools.md` document. The original document combined the classification mechanism (this file) with the 25-tool ibatexas-domain catalog. **The tool catalog stays in the ibatexas adopter.** Only the classification and capability-planning machinery — the runtime-side pattern any `@claustrum/core`-based adopter needs — migrates to claustrum.

The runtime exposes capabilities to the LLM via a single tool surface (`express_intent(capability, payload)`). Tool *identity* — which concrete implementation handles a capability, what its internal id is, whether it is read-only or mutating — is hidden from the LLM. The classification mechanism described here is what makes that hiding load-bearing rather than cosmetic.

This is the runtime-side operationalisation of [ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md). The constitutional declaration ("LLM has zero state-mutation authority") is realised in code through (1) the READ_ONLY vs MUTATING partition, (2) state-gated visibility, and (3) the `CapabilityPlanner`.

---

## The classification partition

Every tool is statically classified as one of:

- **READ_ONLY** — the LLM may invoke this tool's capability directly during a turn. It performs no state mutation. Result is available to the LLM as it continues reasoning.
- **MUTATING** — the LLM **cannot** invoke this tool. Instead, the runtime translates the LLM's `express_intent(capability, payload)` call into an `IntentEnvelope<kind, payload>` and submits it to `adjudicate()`. The kernel's `Decision` governs whether the tool's `execute()` runs.

The classification is **type-enforced** at registration: `ToolDefinition.classification: "READ_ONLY" | "MUTATING"` is a required field. The `ToolRegistry` indexes by classification so the `CapabilityPlanner` can produce LLM-visible tool lists without leaking MUTATING tools.

In the ibatexas reference adopter (pre-cutover) this lived as a `TOOL_CLASSIFICATION` constant at `packages/llm-provider/src/machine/types.ts`. The claustrum-side equivalent is a field on `ToolDefinition` in `@claustrum/core`'s `ToolRegistry`. The `@claustrum/conformance` suite includes the property test "no MUTATING tool ever appears in the LLM-visible capability list" (CC-001 in the conformance suite).

---

## Capability Planner

The `CapabilityPlanner` is the runtime component that builds the LLM-visible capability list for a turn. It is **security-sensitive** and intentionally separated from cosmetic prompt rendering (the `PromptComposer`).

Inputs:
- The current `Capsule` (tenant, actor, channel, session state)
- The set of tools registered for this turn's `agent` / `ToolPack`
- (Optional) per-state visibility allow-list — see "State-gated visibility" below

Output: an ordered list of `CapabilityDescriptor`s — the *capability ids* the LLM may invoke this turn, with their input schemas. Internal tool ids are never in this list.

The planner is the right place to enforce per-tenant policy hooks like "this tenant has not paid for the loyalty tier, so the loyalty-related capabilities are hidden." Visibility filtering happens **here**, not in the prompt template, so a regression cannot leak a hidden capability by accident.

---

## State-gated visibility

When an adopter layers a deterministic state machine behind the LLM (see [ADR-002 (Hybrid State-Flow)](../../decisions/0002-hybrid-state-flow.md)), each machine state may declare an allow-list of capabilities the LLM may invoke in that state. The `CapabilityPlanner` consults the current machine state and intersects with the registered capabilities. This is the "state-gate" referenced in ADR-004's 8-layer defense (layer 5).

Example shape (adopter-domain — `@claustrum/core` defines the interface, the adopter populates the table):

```typescript
const allowedCapabilities: Record<MachineState, CapabilityId[]> = {
  idle:               ["customer.profile.read", "catalog.search"],
  browsing:           ["catalog.search", "catalog.details", "catalog.inventory", "delivery.estimate"],
  checkout:           [],  // no capabilities — the machine drives this stage
  // ... etc
};
```

When the state restricts capabilities to `[]`, the LLM has nothing it can invoke this turn. Its job is purely natural-language synthesis on top of state the machine maintains.

---

## Three-layer defense

The classification mechanism is one layer of three. The full defense (recapitulated from ADR-004 with runtime-side specificity):

1. **Prompt layer.** The LLM is told it has zero authority and is given a closed vocabulary of capability ids, not internal tool names. No "CHAME" / "call this tool" directives for mutating capabilities.
2. **API layer.** `express_intent(capability, payload)` is the only LLM-facing tool. For MUTATING capabilities, the runtime constructs an `IntentEnvelope` and routes through `adjudicate()`. State-gated visibility means a capability not in the allow-list is *not even nameable* to the LLM.
3. **Machine layer.** Guarded state-machine transitions (e.g. `canCancelOrder`, `canAmendOrder`, `hasOrderId`) prevent invalid operations even when an `EXECUTE` decision returns from the kernel — the adopter's domain code is the final gate on transition legality.

---

## What stays in the adopter

The concrete tool catalog — the actual `search_products`, `add_to_cart`, `create_reservation`, etc. — is **adopter-domain code**. It is registered with `@claustrum/core`'s `ToolRegistry` as a `ToolPack` from `claustrum-bootstrap.ts`. Each `ToolDefinition` declares its `capability`, `inputSchema`, `outputSchema`, `intentKind`, `classification`, and `execute(input, capsule)` function.

For the historical ibatexas catalog (~25 tools across Catalog, Commerce, Reservation, Intelligence, Support, Loyalty), see the ibatexas-side document `docs/architecture/design/agent-tools.md` (pre-cutover the implementation lived at `packages/llm-provider/src/tool-registry.ts`; post-cutover the catalog is registered via the adopter's `ToolPack`s and the document remains in the ibatexas docs tree as the canonical catalog reference).

---

## Cross-references

- [ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md) — the constitutional basis for this mechanism.
- [ADR-002 (Hybrid State-Flow)](../../decisions/0002-hybrid-state-flow.md) — state-gated visibility plugs into the XState machine pattern documented here.
- [`docs/architecture/design/runtime-kernel-layer-split.md`](./runtime-kernel-layer-split.md) — why the classification is runtime-side (it is about *what the LLM sees*, not about *what is permitted to execute*; the latter is kernel-side).
- `@claustrum/core` `ToolRegistry` + `ToolDefinition` types.
- `@claustrum/conformance` CC-001 — "the LLM never sees a tool by its internal id, only by capability."

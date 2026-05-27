# @claustrum/core ports — STATUS

> Phase 3 adapter agents (LLM, channel, memory, grounding, etc.) check this
> document before starting. A port marked **FROZEN** is safe to depend on —
> shape will not change without a major version bump.
>
> A port marked **DRAFT** is still in flux and adapters must wait.

| # | Port | File | Status |
|---|---|---|---|
| 1 | `ModelProvider` | `model-provider.ts` | FROZEN |
| 2 | `MemoryPort` | `memory.ts` | FROZEN |
| 3 | `GroundingPort` | `grounding.ts` | FROZEN |
| 4 | `ChannelDriver` | `channel.ts` | FROZEN |
| 5 | `PlannerPort` | `planner.ts` | FROZEN |
| 6 | `ResponderPort` | `responder.ts` | FROZEN |
| 7 | `ExplainerPort` | `explainer.ts` | FROZEN |
| 8 | `HandoffPort` | `handoff.ts` | FROZEN |
| 9 | `SessionPort` | `session.ts` | FROZEN |
| 10 | `TelemetryPort` | `telemetry.ts` | FROZEN |
| 11 | `Adjudicator` | `adjudicator.ts` | FROZEN |
| 12 | `FewShotIndex` | `few-shot.ts` | FROZEN |
| 13 | `TenantResolver` | `tenant.ts` | FROZEN |

All 13 ports are FROZEN as of `@claustrum/core@0.1.0`. Phase 3 adapter
agents (`llm-providers-builder`, `channel-adapters-builder`,
`memory-adapter-builder`, `grounding-adapter-builder`) may proceed.

## Frozen-shape commitments

- Interfaces are exported types — adapters implement, never re-declare.
- All methods that touch I/O return `Promise<T>`. Synchronous getters
  (`current()`, `isStale()`) are documented exceptions.
- `Adjudicator` is the SOLE kernel-facing port. Adapters import kernel
  types (`IntentEnvelope`, `Decision`, `AuditRecord`, `Refusal`) for
  TYPING only; they never call adjudicate-core directly.

## Capsule-as-context

The runtime passes a `Capsule` (not `RuntimeContext`) to tool
`execute()` calls. Tool authors who need state mutation MUST go through
the kernel via `capsule.adjudicate(...)` and react to the returned
Decision — never mutate directly.

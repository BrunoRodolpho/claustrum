# @claustrum/*

> *"What is the function of the claustrum?"* — Crick, F. & Koch, C. (2005). *Philosophical Transactions of the Royal Society B*, 360(1458), 1271–1279. The claustrum is a thin, densely-connected sheet of neurons reaching into nearly every cortical region — hypothesised as the **integrator** that binds disparate cortical streams into unified conscious experience.

**`@claustrum/*` is a governance-native conversational runtime framework.** The package family is named for the brain structure because the runtime does exactly the claustrum's job: it integrates memory, retrieval, planning, persona, channels, and tool execution into one coherent conversational turn — while the LLM (the cortex) generates language and [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate) (the brainstem) governs every state mutation.

Most agent frameworks (LangChain, CrewAI, AutoGen, Mastra) **center the LLM**. Claustrum **centers the runtime** — the LLM is one cortical component the orchestrator routes signals through, not the authority that decides what executes. Every mutation flows as an `IntentEnvelope` to `@adjudicate/core`, which returns one of six decisions: `EXECUTE`, `REFUSE`, `DEFER`, `ESCALATE`, `REQUEST_CONFIRMATION`, or `REWRITE`. The runtime adapts. The LLM has zero state-mutation authority.

This is **the first governance-native conversational runtime framework**. Botpress, Dialogflow, Rasa have the runtime half without a governance kernel. OPA and AWS Verified Permissions have the kernel half without a conversational layer. claustrum + adjudicate occupies the intersection.

## Three pillars

```
┌──────────────────────────────────────────────────┐
│                    your app                       │  APP — domain, business logic
│       (built on @claustrum/* + @adjudicate/*)     │  fast-moving, tenant-specific
└──────────────────────────────────────────────────┘
                       ▲
                       │  npm dep
                       │
┌──────────────────────────────────────────────────┐
│                  @claustrum/*                     │  RUNTIME — cognitive orchestration
│   memory · planner · prompt synthesis · tools     │  fast-moving framework
│   retrieval · grounding · channels · sessions     │  "the conductor of the cortical
│   multi-agent · telemetry · MCP adapters          │   orchestra" (Crick & Koch 2005)
└──────────────────────────────────────────────────┘
                       ▲
                       │  npm dep
                       │
┌──────────────────────────────────────────────────┐
│                  @adjudicate/*                    │  KERNEL — constitutional
│   policy · taint · audit · replay · refusal       │  slow-moving substrate
│   semantics · supersession · identity · sovereign │
└──────────────────────────────────────────────────┘
```

**Strict dependency direction:** `apps → runtime → kernel`. Never the reverse. Never sideways.

**Invariant:** Runtime may be probabilistic (hallucinate plans, rank memories, choose models). Kernel must remain deterministic (verify, refuse, replay, hash, audit). If a proposed change makes the kernel non-deterministic, it does not belong in the kernel.

## Packages

| Package | Responsibility |
|---|---|
| [`@claustrum/core`](./packages/core) | Conductor, Capsule, `handleTurn` cognitive loop, 13 port interfaces, Adjudicator interface |
| [`@claustrum/anthropic`](./packages/anthropic) | Anthropic `ModelProvider` adapter |
| [`@claustrum/openai`](./packages/openai) | OpenAI `ModelProvider` adapter |
| [`@claustrum/channel-whatsapp`](./packages/channel-whatsapp) | Twilio WhatsApp `ChannelDriver` |
| [`@claustrum/channel-web`](./packages/channel-web) | Web/HTTP `ChannelDriver` |
| [`@claustrum/memory-postgres`](./packages/memory-postgres) | Postgres-backed episodic + semantic memory |
| [`@claustrum/grounding-pgvector`](./packages/grounding-pgvector) | pgvector RAG + grounding-proof generation |
| [`@claustrum/conformance`](./packages/conformance) | Runtime-side invariant tests adopters can run |
| [`@claustrum/cli`](./packages/cli) | CLI — scaffolding, conformance runner, replay tools |
| [`@claustrum/eslint-config`](./packages/eslint-config) | Shared ESLint configuration for all `@claustrum/*` packages |

## Installation

```bash
npm install @claustrum/core @claustrum/anthropic @adjudicate/core
```

## 30-second example

```typescript
import { createConductor, handleTurn } from "@claustrum/core";
import { AnthropicProvider } from "@claustrum/anthropic";

const conductor = await createConductor({
  modelProvider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  // ...other providers via port interfaces
});

const capsule = await conductor.openCapsule({
  channel: "web",
  customerId: "cust_123",
  inbound: { text: "Refund the last R$ 200 charge." },
});

const result = await handleTurn(capsule, capsule.inbound);
// result.decision ∈ { EXECUTE | REFUSE | DEFER | ESCALATE | REQUEST_CONFIRMATION | REWRITE }
// result.response — user-facing text
// result.audit  — auditHash for replay
```

The runnable end-to-end demo:

```bash
cd examples/minimal-chat
cp .env.example .env  # add your ANTHROPIC_API_KEY
pnpm install
pnpm --filter @example/minimal-chat dev
```

## How claustrum compares

|                                              | LangChain / Mastra | LLM tool-use | Botpress / Dialogflow | claustrum |
|---                                           |---                 |---           |---                    |---         |
| Cognitive loop as first-class abstraction    | partial            | ✗            | ✗                     | ✓          |
| LLM has zero state-mutation authority        | ✗                  | ✗            | ✗                     | ✓          |
| Tool visibility filtered by capability       | ✗                  | ✗            | ✗                     | ✓          |
| Streaming + mid-stream adjudication          | ✗                  | ✗            | ✗                     | ✓          |
| Audit-grade decision provenance per turn     | ✗                  | ✗            | ✗                     | ✓ (via kernel) |

LangChain ships LLM → tool → database in one call. claustrum inserts a deterministic kernel between the model and the side effect; the LLM emits `express_intent(capability, payload)` and never sees a tool by its internal id. The cognitive loop owns memory, prompts, channels, sessions — none of which touch the kernel's deterministic surface.

## Pairs with `@adjudicate/core`

claustrum requires `@adjudicate/core` — the deterministic decision kernel. Where claustrum is **fast-moving and probabilistic** (memory ranking, prompt synthesis, model routing, planning), adjudicate is **slow-moving and deterministic** (mutation authorization, audit emission, replay-against-historical-policy). The split is intentional: enterprises trust adjudicate; users love claustrum.

See [`@adjudicate/core`](https://github.com/BrunoRodolpho/adjudicate) for the kernel; see [`docs/architecture/design/runtime-kernel-layer-split.md`](./docs/architecture/design/runtime-kernel-layer-split.md) for the long-form rationale.

## Status

> **`v0.1.0-experimental`** — initial publication. See [`PROJECT_STATUS_AND_NEXT_STEPS.md`](./PROJECT_STATUS_AND_NEXT_STEPS.md) for the priority-ordered roadmap to v1.0.

## Documentation

- **Architecture** — [`docs/architecture/design/runtime-kernel-layer-split.md`](./docs/architecture/design/runtime-kernel-layer-split.md): the long-form layer-split design.
- **AI agents** — [`CLAUDE.md`](./CLAUDE.md): runtime-side constitution, the cognitive loop, ports, the `Capsule` per-turn handle.
- **Load-bearing decisions** — ADRs at [`docs/decisions/`](./docs/decisions/).

## License

[MIT](./LICENSE)

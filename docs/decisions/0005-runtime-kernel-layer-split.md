# ADR-005: Runtime/Kernel Layer Split — `@claustrum/core` over `@adjudicate/core`

- **Status:** Accepted — migrated from ibatexas `docs/architecture/decisions.md` #15.
- **Date:** 2026-05-26. Original ibatexas heading: "Runtime/Kernel Layer Split — `@ibx/runtime` over `@adjudicate/core` (2026-05-26)". Renamed because the runtime was subsequently built from scratch as `@claustrum/core` in a separate repo, not as `@ibx/runtime` extracted in-place from ibatexas.
- **Long-form design:** [`docs/architecture/design/runtime-kernel-layer-split.md`](../architecture/design/runtime-kernel-layer-split.md)

## Decision

The system is **two layers with separate evolution rates and separate purity contracts**.

- **The conversational runtime (`@claustrum/core`, historically prototyped as ibatexas `packages/llm-provider/` under the provisional name `@ibx/runtime`)** is the intelligence layer. It is allowed to be probabilistic, experimental, fast-moving. It owns memory, retrieval, prompt synthesis, persona, planning, model routing, tool selection, the multi-agent broker, LLM-trace storage, channel adapters, and the eventual "Invisible UI" / operator-class agent surface.
- **The adjudicate kernel (`@adjudicate/core`)** is the constitutional layer. It must remain deterministic, narrow, slow-moving. It owns mutation authorization, taint analysis, refusal taxonomy, audit emission, supersession semantics, replay, identity attestation, sovereignty rules, cost-cap enforcement, grounding-proof verification, and the semantic firewall.
- **The contract between them is `IntentEnvelope` in, `Decision` out.** Nothing else crosses. The runtime does not import kernel internals; the kernel exposes read APIs for the runtime to consume audit/outcomes data without reaching into Postgres directly.

## The invariant — runtime may be probabilistic; kernel must remain deterministic

This rule survives team turnover and code review. Runtime may hallucinate plans, rank memories probabilistically, infer intent, choose models heuristically. Kernel must deterministically verify, deterministically refuse, deterministically replay, deterministically hash, deterministically audit. If a proposed change makes the kernel non-deterministic, it does not belong in the kernel.

## Why

Adjudicate's commercial and architectural value comes from its narrow responsibility — it is closer to PostgreSQL or the Linux LSM hooks than to a chatbot framework. The moment it owns prompts, memory, retrieval, persona, or agent routing, it stops being deterministic, replayable, mathematically analysable, and auditable to regulator standard. It becomes another AI framework.

Conversely, the runtime layer is where users experience intelligence, fluidity, helpfulness — that layer needs room to experiment, swap models, ship features weekly. Bundling the two at the same evolution rate would sabotage both.

This is the architectural form of the LLM-Authority hard rule operationalised in `CLAUDE.md`. [ADR-004 (Intent-Gated Execution)](./0004-intent-gated-execution.md) declares the kernel is always authoritative; this decision declares **what the kernel is *not***.

## Distributed-systems analog

The standard against which design proposals are evaluated:

| This system | Analog |
|---|---|
| `@claustrum/core` | Kubernetes control plane |
| `@adjudicate/core` | Linux security kernel / LSM hooks |
| `IntentEnvelope` | RPC protocol |
| `Decision` | syscall result |
| `AuditRecord` ledger | append-only event journal |
| Packs | policy modules |
| `RuntimeContext` | tenancy / security boundary |

Anything that would make adjudicate "act more like a chatbot" is a category error.

## What stays in the runtime (must NOT be pulled into `@adjudicate/core`)

- conversational memory · episodic memory · customer-state memory
- retrieval / RAG / embeddings / vector stores
- prompt synthesis · persona · voice · streaming
- planning · goal decomposition · tool selection
- model routing (Haiku vs Sonnet per turn)
- LLM-trace storage (prompts, completions, logprobs)
- multi-agent broker · agent personalities · A2A handoff
- channel adapters · UI navigation
- self-teaching from website ingestion

## What stays in (or moves into) the kernel

- mutation authorization · the 6-variant `Decision` space
- taint lattice + `INDIRECT` taint rank (when added)
- audit emission · supersession chains · content-addressed `auditHash`
- refusal taxonomy · basis-code vocabulary
- replay · drift classification · `adjudicatePlan(IntentEnvelope[])`
- identity attestation (DID / signed envelopes)
- sovereignty rules (residency policy)
- cost-cap *enforcement* (the refusal when monthly cap exceeded; routing is runtime)
- grounding-proof *verification* (the runtime produces proofs; the kernel verifies them)
- semantic firewall (`InputGuard` phase, `adjudicateOutput`)
- kernel-mediated tool execution (every read/write tool through `adjudicate()`)
- audit-record redaction at emit time (`AuditRedactor`)

## Shared platform concerns (live in CI / adopter docs, span both repos)

- lint rule forbidding raw `prisma.*` outside `withAdjudicate` (adopter-side)
- shadow-mode bypass detector (NATS subscriber + Prisma middleware) (adopter-side)
- tarball hygiene CI gate (`files` field check)
- coverage burndown for migration tracking
- operator console (Black Box Recorder UI — consumes kernel replay + runtime LLM-trace)
- live WebSocket decision stream
- executable spec docs (`.mdx` literate tests)

## Implications

1. **`packages/llm-provider/` (ibatexas) was renamed and rebuilt.** Originally this ADR called for renaming in-place to `@ibx/runtime`. The stronger superseding decision: extract the runtime to its own repo (`BrunoRodolpho/claustrum`), **build it from scratch** rather than extract the existing tangle, and publish as `@claustrum/*`. The ibatexas `packages/llm-provider/` was deleted in the claustrum cutover; the new ibatexas chat code is built fresh on top of `@claustrum/core`. Names shape architecture; the rebuild forces the correct mental model.
2. **`IntentEnvelope` becomes a wire protocol, not just a TypeScript type.** Versioned shapes, schema-evolution discipline (protobuf-style optional/reserved fields), canonical hashing using the existing `sha256Canonical` rule. See [ADR-001 (IntentEnvelope wire protocol)](./0001-intent-envelope-wire-protocol.md).
3. **Cost is three things, not one.**
   - *Enforcement* (a kernel policy guard that REFUSEs on budget exceeded) is K-side.
   - *Routing* (Haiku vs. Sonnet per turn) is R-side.
   - *Telemetry* ($-spent per tenant per week) is shared platform.
   The runtime tells the kernel the current spend via an envelope context field; the kernel refuses or permits.
4. **The runtime layer existed in nascent form** at ibatexas `packages/llm-provider/src/{agent,prompt-synthesizer,llm-responder,intent-dispatcher,kernel-executor,session}.ts` + `machine/` pre-cutover. Rather than rename and audit imports in place, the work was to **rebuild it from scratch in claustrum** — explicit boundary, no carried tangle.
5. **Memory is runtime, but the audit ledger is kernel-owned.** The runtime's deep-memory layer may *read* the audit ledger via a stable kernel API (`Adjudicator.replayEnvelopesByCustomerId`); it does not own the ledger and does not write to it directly.

## Forthcoming / completed ADRs

- [ADR-001 (IntentEnvelope wire protocol)](./0001-intent-envelope-wire-protocol.md) — schema, hashing, evolution policy. (Originally listed as "ADR 16" in the ibatexas forward-references.)
- A future ADR documenting the package-boundary audit and lessons learned from the build-from-scratch decision. (Originally listed as "ADR 17 — `@ibx/runtime` rename and package boundary audit"; superseded by the cleaner build-from-scratch path.)

## Strategic positioning

*"The first governance-native conversational operating system."* Runtime is what users love; kernel is what enterprises trust. Most AI stacks build only the lovable runtime and later panic about governance, audit, hallucinations, agent safety. This architecture solves both from day one because the layers are separate-but-tied — the runtime cannot bypass the kernel, and the kernel cannot drift into runtime concerns.

## Cross-references

- [`docs/architecture/design/runtime-kernel-layer-split.md`](../architecture/design/runtime-kernel-layer-split.md) — long-form design and reclassified roadmap (28 → R/K/S split).
- [`docs/research/synthesis-conversational-ai-comparison.md`](../research/synthesis-conversational-ai-comparison.md) — synthesis predecessor (raw comparison); the layered split corrects misclassifications in that document's v1 roadmap.
- [ADR-004 (Intent-Gated Execution)](./0004-intent-gated-execution.md) — declares the kernel is always authoritative; this ADR declares what it is *not*.
- [ADR-002 (Hybrid State-Flow)](./0002-hybrid-state-flow.md) and [ADR-003 (Conversation Persistence CDC)](./0003-conversation-persistence-cdc.md) — sibling runtime-side decisions that depend on this layer split being clean.
- [ADR-001 (IntentEnvelope wire protocol)](./0001-intent-envelope-wire-protocol.md) — the contract this ADR claims is the only thing that crosses.
- **Historical:** ibatexas `packages/llm-provider/` (pre-claustrum-cutover, deleted) — the runtime layer in its prototype location.
- **`@adjudicate/core` source:** [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate).

# Runtime / Kernel Layer Split

> Architectural design accompanying [ADR-005](../../decisions/0005-runtime-kernel-layer-split.md). This document is the long-form spec; the ADR is the constitutional declaration.
>
> **Migrated from ibatexas.** Originally written as `docs/architecture/design/runtime-kernel-layer-split.md` in `BrunoRodolpho/ibatexas` when the runtime layer was provisionally named `@claustrum/core` and lived inside the ibatexas monorepo at `packages/llm-provider/`. Package references in this document have been normalised to `@claustrum/core`; historical paths into `packages/llm-provider/` are retained as pre-cutover context and are marked accordingly.

## TL;DR

The system is two layers with separate evolution rates and separate purity contracts.

- **`@claustrum/core`** is the *intelligence layer*. Fast-moving, allowed to be probabilistic, owns everything conversational. (Historically prototyped inside ibatexas at `packages/llm-provider` under the provisional name `@claustrum/core`.)
- **`@adjudicate/core`** is the *constitutional layer*. Slow-moving, must remain deterministic, owns mutation authorization and audit.
- The only contract between them is **`IntentEnvelope` in, `Decision` out**.
- **Invariant:** Runtime may be probabilistic; the kernel must remain deterministic. If a proposed change makes the kernel non-deterministic, it does not belong in the kernel.

The system is closer to *distributed-systems infrastructure* than to a chatbot framework. The kernel is to mutation authorization what PostgreSQL is to durability — a narrow, trusted substrate. The runtime is everything users experience.

---

## The two layers

```
                ┌──────────────────────────────────────────┐
                │      Channels (WhatsApp, Web, ...)        │
                └──────────────────────────────────────────┘
                                  │
                ┌──────────────────────────────────────────┐
                │   @claustrum/core ("Conversational OS")   │
                │   memory · retrieval · prompts · planner  │
                │   tool selection · persona · streaming    │
                │   multi-agent broker · UI actions         │
                │   model routing · embedding ports         │
                │   FAST-MOVING, experimental, opinionated  │
                └──────────────────────────────────────────┘
                                  │   IntentEnvelope (wire format)
                                  ▼
                ┌──────────────────────────────────────────┐
                │   @adjudicate/core  ("The Constitution")  │
                │   policy · taint · audit · supersession   │
                │   refusal taxonomy · replay · identity    │
                │   sovereignty · cost-ceiling enforcement  │
                │   SLOW-MOVING, narrow, mathematically pure │
                └──────────────────────────────────────────┘
                                  │   Decision (EXECUTE / …)
                                  ▼
                ┌──────────────────────────────────────────┐
                │   Execution layer (Prisma, Stripe, …)     │
                └──────────────────────────────────────────┘
```

| Layer | Purpose | Owns | Evolution rate |
|---|---|---|---|
| **`@claustrum/core`** | Make the system feel intelligent, fluid, helpful | Conversational memory, retrieval, prompt synthesis, persona, planning, model routing, tool selection, multi-agent broker, LLM-trace storage, channel adapters, UI navigation | **Fast** — weekly experimentation; opinionated; allowed to swap models, prompts, memory ranking strategies |
| **`@adjudicate/core`** | Make the system safe, auditable, replayable | Mutation authorization, taint, audit, supersession, refusal taxonomy, replay, identity attestation, sovereignty, cost-cap enforcement, grounding-proof verification, semantic firewall | **Slow** — semver-disciplined; breaking changes treated like a database protocol migration; mathematical clarity over feature velocity |

---

## The invariant: deterministic kernel, probabilistic runtime

| Layer | Allowed to be fuzzy? |
|---|---|
| Runtime | **Yes** |
| Kernel | **No** |

**Runtime may:**
- Hallucinate plans (the planner can be wrong; the kernel will refuse bad envelopes)
- Speculate about user intent
- Rank memories probabilistically
- Choose models heuristically (Haiku for greetings, Sonnet for checkout)
- Use embeddings, vector similarity, fuzzy matching
- Infer intent from natural-language input
- Experiment with prompt variations week-to-week

**Kernel must:**
- Deterministically verify the same envelope produces the same decision
- Deterministically refuse on policy violations
- Deterministically replay historical envelopes against current policy
- Deterministically hash audit records (`sha256Canonical`)
- Deterministically emit audit records — no fire-and-forget, no probabilistic sampling
- Be functionally pure on its synchronous path (no I/O, no async, no randomness in `_adjudicateImpl`)

**Why this matters.** Determinism is what makes audit records evidence rather than artifacts. It is what makes replay-against-historical-policy a regulator-grade tool rather than a debugging aid. It is what makes the kernel the kind of thing an enterprise will trust to mediate every mutation. The moment the kernel becomes probabilistic — "this guard *usually* refuses" — the entire value proposition collapses.

---

## The contract: `IntentEnvelope` in, `Decision` out

```typescript
// At the boundary:
@claustrum/core  →  IntentEnvelope<kind, payload>  →  @adjudicate/core
@claustrum/core  ←  Decision (one of 6 variants)   ←  @adjudicate/core
```

The 6-variant `Decision` is the *only* return shape: `EXECUTE | REFUSE | ESCALATE | REQUEST_CONFIRMATION | DEFER | REWRITE`. The runtime adapts to all six. Audit emission is a kernel side effect, not a runtime concern.

### Today

`IntentEnvelope` is a TypeScript shared type defined in `@adjudicate/core`. It works as a contract while runtime and kernel live in the same process, but it is **not yet a wire protocol** — there is no JSON Schema, no versioning policy, no canonical hashing rule for envelope identity (only for audit records).

### What's needed (codified in [ADR-001](../../decisions/0001-intent-envelope-wire-protocol.md))

For the runtime to eventually become a separate process (a precondition for multi-agent, R-4, and for federated pods, K-11):

1. **Versioned envelope shapes.** Protobuf-style optional/reserved-field discipline. Breaking changes follow database-migration ceremony.
2. **Canonical hashing rule.** Reuse the existing `sha256Canonical` from `audit.ts` so envelope identity is deterministic across processes.
3. **JSON Schema published alongside the type.** So polyglot runtimes can construct valid envelopes.
4. **Schema-evolution policy.** Documented "what can be added," "what can be deprecated," "what triggers a major version" — analogous to the per-CHANGELOG semver discipline `@adjudicate/core` already practices.

### Read APIs (the inverse contract)

The runtime sometimes needs to *read* kernel-owned data — memory layer wants past envelopes for this customer, teacher-loop wants outcomes by guard. The kernel exposes these as stable read APIs; the runtime does not reach into Postgres directly.

Proposed (subject to envelope-protocol ADR):

```typescript
// Stable read API surface, kernel-side
replayEnvelopesByCustomerId(customerId, since): AuditRecord[]
streamAuditRecordsByIntentHash(intentHashPrefix): Observable<AuditRecord>
getOutcomes(filter: { guardId?; basisCodes?; window? }): OutcomeRow[]
verifyAuditRecord(record): { ok: true } | { ok: false; reason }
```

---

## What belongs in `@claustrum/core`

These are runtime concerns. Adding any of them to `@adjudicate/core` is a category error.

| Capability | Notes |
|---|---|
| **Conversational memory** | Episodic + customer-state + preference + relationship memory. Backed by runtime-owned tables. May read the audit ledger via kernel read APIs but does not write to it. |
| **Planning** | Goal decomposition, tool selection, clarification questions. Every concrete mutation it plans becomes an `IntentEnvelope`. |
| **Retrieval + grounding** | RAG pipelines, vector stores, embedding ports. Produces `groundingProof` objects attached to envelopes. The proof is *verified* by the kernel (K-side); the *retrieval* is R-side. |
| **Prompt synthesis** | Persona, voice, channel-specific tone, streaming behavior. (Historical: prototyped in ibatexas at `packages/llm-provider/src/prompt-synthesizer.ts` pre-cutover; the claustrum replacement is `@claustrum/core`'s `PromptComposer`.) |
| **Model routing** | `routeModel(complexity, plan, spendLeft)`. Picks Haiku vs. Sonnet per turn. **Cost-cap enforcement stays in the kernel** — runtime tells the kernel current spend via envelope context; the kernel REFUSEs if over cap. |
| **LLM-trace storage** | Prompt hash, completion, logprobs, tool-selection reasoning. New `LLMTraceSink` interface defined by runtime; persisted to runtime-owned store; correlated to audit records via `intentHash`. |
| **Multi-agent broker** | The actual A2A dispatch — `whatsappAgent` ↔ `chatAgent` ↔ specialised agents. Uses `IntentEnvelope` as the inter-agent context object. Kernel never knows about agents — just sees envelopes. |
| **Teacher-loop job** | Nightly clusterer over kernel-owned `outcomes_store`. Reads via stable kernel API. Outputs *proposed Pack diffs* for humans to review. The kernel only sees results via normal Pack adoption. |
| **Auto-curriculum job** | Same shape as teacher-loop but for property-test generation. Reads refusal clusters; opens PRs against test files. Never modifies kernel internals. |
| **Channel adapters** | WhatsApp gateway, web session attestor, future channels (voice, email, IG). Each adapter signs envelopes before submission. |
| **"Invisible UI" / operator-class agent** | Web-page action layer — highlighting buttons, filling forms, navigating. Pure runtime concern; mutations it proposes flow to the kernel like any other intent. |
| **Self-teaching from ingestion** | Ingest company docs → semantic graph → synthetic intent generation. Output is candidate intents the kernel can later authorize. |

---

## What belongs in `@adjudicate/core`

These extend the kernel along its existing grain: more policy primitives, more typed decisions, more safety. They evolve slowly with semver discipline.

| Capability | Status |
|---|---|
| **6-variant `Decision`** | Existing. Stable. |
| **Basis-code vocabulary** | Existing, additive only. New basis codes are minor-version bumps. |
| **Taint lattice** | Existing (SYSTEM/TRUSTED/UNTRUSTED). Will gain `INDIRECT` rank + field-level `TaintedValue<T>`. |
| **Audit record + supersession chains** | Existing v4. Content-addressed `auditHash`, optional KMS/HSM signature. |
| **Replay** | Existing as harness; will be promoted to first-class kernel API `replay(record, freshPolicy)`. |
| **`adjudicatePlan(IntentEnvelope[])`** | New. Transactional multi-step adjudication — emits one `EXECUTE` only if every step would individually EXECUTE. The "AI conductor" primitive. |
| **`InputGuard` semantic firewall** | New kernel phase before state/auth/taint/business. Detects prompt injection, jailbreak, instruction-override. New `validation:*` basis codes. |
| **`adjudicateOutput(response, context)`** | New. Mirror of `adjudicate()` for response governance. PII scan, forbidden-phrase enforcement, grounding-check. |
| **Grounding-proof verification** | New basis category `grounding`: `PROOF_PRESENT` / `MISSING` / `STALE` / `UNVERIFIABLE`. Runtime produces, kernel verifies. |
| **Cryptographic actor identity** | `actor: { principal: DID \| "system"; attestation: SignedJWT }`. Channel signs envelope before submission; kernel verifies. New basis codes `auth.IDENTITY_UNATTESTED` / `ATTESTATION_INVALID`. |
| **`SovereigntyPolicy`** | Per-tenant `{region, allowedSinks, residencyAttestation}` in `RuntimeContext`. Kernel REFUSEs envelopes whose payload would route through a non-compliant sink. Basis `business.RESIDENCY_VIOLATION`. |
| **Cost-cap enforcement** | Policy guard: REFUSE with `business:rule_violated { reason: "budget_exceeded", monthlySpendUsd }`. Runtime supplies current spend via envelope context. |
| **Kernel-mediated tool execution** | Every tool call (read AND write) routes through `adjudicate()`. Read tools get `kind: "tool.read.*"`. Closes read-tool enumeration gap. |
| **`AuditRedactor` at emit time** | Tenant-configured field paths salt-hashed before sealing. LGPD Art. 18 right-to-erasure on the ledger via salt rotation. New supersession reason `lgpd_erasure_audit`. |
| **Federated `RuntimeContext` pods** | Network-addressable per-region pods; audit records gossip via content-addressed CRDT. Sovereign data pods, kernel-side. |
| **Drop singleton fallback in `RuntimeContext`** | Force multi-tenant cleanliness from day one of v2. |
| **Stable read APIs** | `replayEnvelopesByCustomerId`, `streamAuditRecordsByIntentHash`, `getOutcomes(filter)`. The inverse of the envelope/Decision contract — how runtime reads kernel-owned data. |

---

## Forbidden in each layer

### Forbidden in `@adjudicate/core`

The kernel must never own:

- **Embeddings.** No vector stores, no similarity, no semantic search inside the kernel.
- **Vector DB orchestration.** That's a runtime infrastructure concern.
- **Memory ranking.** "Which past customer message is most relevant" is a runtime question.
- **Prompt engineering.** No prompt templates, no persona logic, no voice modulation inside the kernel.
- **Conversation synthesis.** The kernel does not generate language. Its outputs are typed `Decision` values plus templated explanations from a closed vocabulary.
- **Persona systems.** Tone, voice, style — all runtime.
- **Emotional intelligence layers.** Sentiment classification, mood inference — runtime.
- **Agent planning / orchestration.** Decomposing a goal, picking which agent handles which step — runtime.
- **Retrieval pipelines.** RAG belongs in runtime; the kernel only verifies the *proofs* RAG produces.
- **Model selection.** The kernel does not know about model names, providers, prices.

### Forbidden in `@claustrum/core`

The runtime must never:

- **Mutate state without an `adjudicate()` call.** Every mutation goes through the kernel. No exceptions. The lint rule (Tier-1 #1) enforces this.
- **Read kernel-owned tables directly.** Use stable read APIs (`replayEnvelopesByCustomerId`, etc.). Reaching into `intent_audit` via Prisma is a contract violation.
- **Define new basis codes.** The basis-code vocabulary is kernel-owned. New codes are minor-version bumps to `@adjudicate/core`, not runtime additions.
- **Bypass the audit ledger.** All decisions are audited by the kernel. Runtime cannot suppress audit emission.
- **Be in the critical path of audit determinism.** Runtime can be slow, fail, restart — the kernel still emits the right audit records.

---

## Reclassified roadmap (35 proposals)

The predecessor synthesis ([`docs/research/synthesis-conversational-ai-comparison.md`](../../research/synthesis-conversational-ai-comparison.md), migrated from ibatexas at `docs/adjudicate-migration/audit-2026-05-24/synthesis-conversational-ai-comparison.md`) listed 28 proposals as if they all belonged to adjudicate. The corrected classification:

### Runtime (`@claustrum/core`) — the conversational OS layer

| ID | Proposal | Notes |
|---|---|---|
| R-1 | **Deep memory** | Episodic + customer-state + preference + relationship. Runtime-owned tables; may read audit ledger via kernel API. |
| R-2 | **Planning layer** | Goal decomposition, tool selection, clarification questions. Output: `IntentEnvelope`s submitted to kernel. |
| R-3 | **Retrieval + grounding** | RAG pipelines, vector stores. Produces `groundingProof`; kernel verifies. |
| R-4 | **Multi-agent broker** | A2A dispatch using `IntentEnvelope` as context object. |
| R-5 | **Model routing** | `routeModel(complexity, plan, spendLeft)`. Picks model per turn. Cost-cap enforcement stays in kernel. |
| R-6 | **LLM-trace store + sink** | Prompt hash, completion, logprobs. Correlated to audit records by `intentHash`. |
| R-7 | **Teacher-loop job** | Nightly clusterer over outcomes_store via kernel read API. Outputs Pack-diff proposals. |
| R-8 | **Auto-curriculum job** | Same shape as R-7 but for property-test generation. Opens PRs. |
| R-9 | **Persona & voice** | Channel-specific tone. (Historical: prototyped pre-cutover in ibatexas `packages/llm-provider/src/prompt-synthesizer.ts:594`; claustrum equivalent is `@claustrum/core`'s `PromptComposer` fragment registry.) |
| R-10 | **"Invisible UI" / operator agent** | Web-page action layer. Mutations flow through kernel like any intent. |
| R-11 | **Self-teaching from website ingestion** | Ingest → semantic graph → synthetic intents. |

### Kernel (`@adjudicate/core`) — the constitutional layer

| ID | Proposal | Notes |
|---|---|---|
| K-1 | **`InputGuard` (semantic firewall)** | New kernel phase. `validation.PROMPT_INJECTION_DETECTED`, etc. |
| K-2 | **`adjudicateOutput`** | Response governance. New envelope kind `llm.response`. |
| K-3 | **Grounding-proof verification** | New basis category `grounding`. |
| K-4 | **`INDIRECT` taint rank + field-level `TaintedValue<T>`** | Closes indirect-injection. |
| K-5 | **Cryptographic actor identity** | DID + signed envelopes from channels. |
| K-6 | **`SovereigntyPolicy`** | Per-tenant residency rules. |
| K-7 | **Cost-cap enforcement primitive** | Policy guard REFUSEs on budget exceeded. |
| K-8 | **Kernel-mediated tool execution** | Every tool call (read + write) through `adjudicate()`. |
| K-9 | **`AuditRedactor` at emit time** | LGPD Art. 18 on the ledger via salt rotation. |
| K-10 | **`adjudicatePlan(IntentEnvelope[])`** | Transactional multi-step adjudication. |
| K-11 | **Federated `RuntimeContext` pods** | Sovereign data pods. |
| K-12 | **Replay-as-API** | Promote replay harness to first-class kernel API. |
| K-13 | **Drop singleton fallback** | Mandatory per-tenant `RuntimeContext`. |
| K-14 | **Stable read APIs for runtime** | `replayEnvelopesByCustomerId`, `streamAuditRecordsByIntentHash`, `getOutcomes`. |

### Shared platform — CI, lint, docs, operator UX

| ID | Proposal | Notes |
|---|---|---|
| S-1 | **Lint-enforced kernel boundary** | `prisma.*` outside `withAdjudicate` → hard error. |
| S-2 | **Shadow-mode bypass detector** | Prisma middleware + NATS subscriber. |
| S-3 | **Tarball hygiene CI gate** | `files` field check; fixes 14 packages. |
| S-4 | **`ibx kernel coverage` burndown** | 363 → 0 raw-Prisma visibility. |
| S-5 | **Black Box Recorder UI** | Operator console; consumes K replay API + R LLM-trace store. |
| S-6 | **Live decision stream** | WebSocket fanout from NATS `audit.*`. |
| S-7 | **Executable spec docs** | `.mdx` literate-test files runnable by vitest. |
| S-8 | **Localized refusal explanations to end users** | Uses kernel `explain.ts` templates; rendered by runtime. |
| S-9 | **Refresh `PROJECT_STATE.md`** | 8 weeks stale. |
| S-10 | **Semantic drift detection** | Reads kernel audit table; emits Prom gauge. |

### Misclassifications in the v1 synthesis (now corrected)

| v1 proposal | Mistake | Now classified as |
|---|---|---|
| LLM-trace embedded in `AuditPlanSnapshot` | Mixed runtime debugging into kernel audit | R-6 (separate `LLMTraceSink` to runtime store; linked to audit by `intentHash`) |
| "Hive-mind protocol with adjudicate as broker" | Kernel does not broker — it adjudicates each envelope | R-4 (runtime is the broker) |
| `BudgetSink` model routing | Conflated enforcement (K) with routing (R) | Split into K-7 + R-5 |
| Teacher loop "on the LearningSink" | The job that *reads* outcomes is runtime | R-7 (runtime job → human review → Pack adoption) |
| Long-term memory "over the audit ledger" | Memory retrieval is runtime | R-1 (runtime memory; reads ledger via kernel read API) |
| Auto-curriculum from refusals | Same as teacher loop | R-8 |
| Black Box Recorder UI | UI is shared platform, not kernel | S-5 |

---

## Historical: how the layer split landed

The original ibatexas plan to rename `packages/llm-provider` → `@ibx/runtime` in-repo was superseded by a stronger decision: the runtime layer is **built from scratch as a separate repo (`BrunoRodolpho/claustrum`) and published as `@claustrum/*`**, not extracted from ibatexas. The ibatexas `packages/llm-provider/` is deleted in the cutover (see ibatexas-side ADR on the claustrum cutover and Phase 6 of the migration plan); the new ibatexas chat code is built fresh on top of `@claustrum/core`.

This section is preserved as historical context for readers tracing the architectural lineage. The substantive items (boundary discipline, kernel-leak audits, runtime-owned tables, doc-map updates) still apply to the post-cutover ibatexas adopter and to any future adopter of `@claustrum/*`:

1. **Audit imports for kernel leaks.** No code outside `@claustrum/core`'s `Adjudicator` port may reach into `@adjudicate/core/internals` or `@adjudicate/core/dist/...`. Replace with public kernel API calls; file issues against `@adjudicate/core` to expose new public APIs as needed.
2. **Memory tables, LLM-trace tables, persona configs** live in runtime-owned schemas — never in the kernel's audit-postgres tables.
3. **Doc-map updates** in adopter `CLAUDE.md` should point at `@claustrum/*` for runtime concerns and `@adjudicate/*` for kernel concerns.
4. **Bounded-contexts documents** in adopter repos should reflect the layer split.

---

## Open questions

These are deliberate non-decisions in [ADR-005](../../decisions/0005-runtime-kernel-layer-split.md). They need their own decisions later.

1. **In-process vs. out-of-process boundary.** Today an adopter such as ibatexas runs runtime and kernel inside the same process (`apps/api` Fastify boots both via the adopter's `claustrum-bootstrap.ts`). Multi-agent (R-4) eventually forces an IPC boundary. Decision needed: NATS request/reply? gRPC? In-process queue? — depends on R-4 timing.
2. **Envelope versioning policy.** [ADR-001](../../decisions/0001-intent-envelope-wire-protocol.md) defines the envelope wire protocol; the semver discipline for protobuf-style additions is captured there.
3. **Memory schema ownership.** If memory lives in runtime-owned tables but customer entity lives in adopter-domain tables, what's the relationship? Foreign key? Customer ID only? Decision deferred until R-1 design.
4. **LLM-trace retention.** The audit ledger has regulator-grade retention. LLM traces (R-6) carry prompts and completions — PII risk. Different retention policy? Different storage tier?
5. **Multi-tenant runtime.** `RuntimeContext` is the kernel's tenancy primitive. claustrum's per-turn handle is `Capsule` — short-lived, distinct from `RuntimeContext`. Open question: does claustrum want a longer-lived `RuntimeSession` analog, or is the per-turn `Capsule` plus a `SessionStore`-backed `Session` enough?
6. **The runtime's testing story.** Kernel has 1,122 tests + property tests + replay-against-historical-policy. The runtime's allowed-to-be-fuzzy nature complicates testing — what's the equivalent confidence-building practice? Scenario tests? Snapshot tests against golden conversations? See `@claustrum/conformance` and PART I §"Testing approach" of the master plan for the four-layer answer.

---

## Distributed-systems analog

This framing is the standard against which design proposals are evaluated.

| This system | Distributed-systems analog |
|---|---|
| `@claustrum/core` | Kubernetes control plane |
| `@adjudicate/core` | Linux security kernel / LSM hooks |
| `IntentEnvelope` | RPC protocol |
| `Decision` | syscall result |
| `AuditRecord` ledger | append-only event journal (Kafka log / WAL) |
| Packs | policy modules (kernel modules, eBPF programs) |
| `RuntimeContext` | tenancy / security boundary (namespace, cgroup) |
| Channel adapters | network interface drivers |
| Memory / retrieval layer | userland databases (Postgres, Redis, vector store) |

The implication: anyone proposing to add "smarts" to the kernel is proposing to add ML to the Linux scheduler. Theoretically interesting; almost always the wrong place.

---

## Strategic positioning

**Category claim:** *"The first governance-native conversational operating system."*

This works because no competitor occupies it:

- **Botpress / Dialogflow / Rasa / Chatwoot** have the runtime half (often less rigorous than what `@claustrum/core` will become); no governance kernel.
- **OPA / AWS Verified Permissions** have the kernel half; no conversational layer.
- **LangChain / AutoGPT** have orchestration but no governance and no audit.

Most AI stacks build only the lovable runtime and panic later about governance, audit, hallucinations, agent safety. This architecture solves both from day one because:

- Runtime is what users love.
- Kernel is what enterprises trust.
- Both are required for the category.
- The layers are separate-but-tied — runtime cannot bypass the kernel; kernel cannot drift into runtime concerns.

The deterministic-kernel + probabilistic-runtime invariant is what makes the category claim defensible. A non-deterministic kernel cannot produce regulator-grade audit. A non-probabilistic runtime cannot feel intelligent. The split is the moat.

---

## Cross-references

- **[ADR-005 (Runtime/Kernel Layer Split)](../../decisions/0005-runtime-kernel-layer-split.md)** — the constitutional declaration.
- **[ADR-004 (Intent-Gated Execution)](../../decisions/0004-intent-gated-execution.md)** — declares the kernel is always authoritative. This ADR extends ADR-004 by also declaring what the kernel is *not*.
- **[ADR-001 (IntentEnvelope wire protocol)](../../decisions/0001-intent-envelope-wire-protocol.md)** — the cross-repo wire format, versioning, and canonical hashing for `IntentEnvelope`.
- **[CLAUDE.md (Hard Rules)](../../../CLAUDE.md)** — Hard Rule #1 (LLM Authority) and Hard Rule #2 (`Capsule` vs `RuntimeContext`) operationalise this layer split day to day.
- **[`docs/research/synthesis-conversational-ai-comparison.md`](../../research/synthesis-conversational-ai-comparison.md)** — the raw comparison and original (now-corrected) 28-proposal roadmap, migrated from ibatexas.
- **Historical (ibatexas adopter, pre-cutover):** `packages/llm-provider/src/` hosted the runtime prototype before the rewrite onto `@claustrum/*`. Deleted in the claustrum cutover (see ibatexas-side ADR).
- **`@adjudicate/core` source:** [BrunoRodolpho/adjudicate](https://github.com/BrunoRodolpho/adjudicate).

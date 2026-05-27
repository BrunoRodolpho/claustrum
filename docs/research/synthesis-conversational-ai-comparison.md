# Synthesis: ibatexas + adjudicate vs. the Conversational AI Landscape

> **Migrated from ibatexas** (originally `docs/adjudicate-migration/audit-2026-05-24/synthesis-conversational-ai-comparison.md` in `BrunoRodolpho/ibatexas`). This is the research synthesis that produced the original 28-proposal roadmap. Several of those proposals were later **reclassified between runtime and kernel** in [ADR-005 (Runtime/Kernel Layer Split)](../decisions/0005-runtime-kernel-layer-split.md) — the runtime/kernel split corrected misclassifications in this document's v1 roadmap (LLM-trace embedded in audit, hive-mind protocol with adjudicate as broker, BudgetSink model routing, teacher-loop on LearningSink, long-term memory over the audit ledger, auto-curriculum from refusals, Black Box Recorder UI). See [`docs/architecture/design/runtime-kernel-layer-split.md`](../architecture/design/runtime-kernel-layer-split.md) §"Reclassified roadmap" and §"Misclassifications in the v1 synthesis" for the corrected classification.
>
> **What "ibatexas" means in this document.** At the time of writing (2026-05-26) the runtime layer was still inside the ibatexas monorepo at `packages/llm-provider/`. The decision to extract the runtime into a separate repo (`BrunoRodolpho/claustrum`, published as `@claustrum/*`, **built from scratch** rather than extracted from ibatexas) was made shortly after this synthesis. References to "ibatexas + adjudicate" below should be read as "the conversational application + the governance kernel" — in the post-cutover world that's "(any `@claustrum/*`-based adopter, of which ibatexas is the flagship) + (`@adjudicate/*` kernel)".

**Date:** 2026-05-26
**Author context:** Produced by a 5-axis parallel investigation (architecture, governance, observability, multi-agent/cost/learning, code health/DX) cross-referencing the live ibatexas + adjudicate codebase against four reference platforms (Dialogflow CX, Rasa, Botpress, Chatwoot) and a visionary "System 3" target.
**Inputs:**
- Live source: `/Users/thaisrodolpho/projects/ibatexas/` and `/Users/thaisrodolpho/projects/adjudicate/` at the state of `@adjudicate/core` v1.1.0 (published 2026-05-25)
- Existing planning tree: `docs/adjudicate-migration/audit-2026-05-24/` (historical in `BrunoRodolpho/ibatexas`)
- Public knowledge of the four reference platforms

---

## The Category Insight (read this first)

**ibatexas + adjudicate is not in the same category as Dialogflow / Rasa / Botpress / Chatwoot.** Those four arbitrate *what the bot says*. Adjudicate arbitrates *what the system does* — every state-mutating intent passes through `adjudicate()` and receives a typed `Decision` with a vocabulary-controlled audit record. The closest analogs outside the chatbot space are **OPA/Rego (policy-as-data)** or **AWS Verified Permissions** — not chatbot platforms.

ibatexas (the app) is the chatbot, comparable to the four. Adjudicate (the kernel) is a governance micro-kernel underneath it. The visionary "System 3" tool isn't "a better chatbot" — it's *a great chatbot platform fused with a great governance kernel*. Adjudicate already owns the governance half. The visionary roadmap is mostly about adding the missing pieces (semantic firewall, LLM-trace observability, A2A, FinOps, teacher-loop) while reusing the seams adjudicate already exposes (basis codes, supersession reasons, ports/adapters sinks, taint lattice).

---

## PART I — The Comparison

### Master comparison table (5 systems × 16 categories)

| Category | Dialogflow CX | Rasa | Botpress | Chatwoot | **ibatexas + adjudicate** |
|---|---|---|---|---|---|
| **Core intent** | Enterprise AI in Google ecosystem | Pro-dev / self-hosting AI | Rapid GenAI visual dev | Customer-support hub | **Mutation-governance kernel + multi-channel app** |
| **Category** | Chatbot platform | Chatbot framework | Chatbot platform | Helpdesk + bots | **Chatbot app + governance micro-kernel** |
| **Foundation** | State machine + Transformer NLU | Modular pipeline (DIET + TED) | LLM-native runtime ("LLMz") | Rails monolith + Sidekiq | **Pure-function 7-phase interceptor over algebraic Decision type** |
| **Research pedigree** | Google BERT/Transformer | Published papers (DIET, TED) | Applied GenAI orchestration | Engineering-focused, no AI research | **None novel — borrows kernel-security ideas (seL4/OPA) into LLM domain** |
| **Decision model** | Route conditions on pages | Policy ML predictions | LLM tool-calling in sandbox | Rule sequences + webhooks | **6-variant tagged union: EXECUTE / REFUSE / ESCALATE / REQUEST_CONFIRMATION / DEFER / REWRITE** |
| **Audit trail** | Cloud Audit Logs (admin) | None structured | Conversation history | Conversation UI per agent | **Content-addressed v4 record (`auditHash = sha256Canonical`), optional KMS/HSM signature, vocabulary-controlled basis codes, supersession chains** |
| **Governance posture** | Cloud IAM (compliance framework) | Code-as-policy (YAML) | Workspace RBAC | Agent/Admin roles | **Fail-closed kernel interceptor; `GUARD_PANIC` → SECURITY REFUSE; taint lattice SYSTEM > TRUSTED > UNTRUSTED** |
| **Observability** | Logs + BigQuery + Insights | Conversation Insights, tracker store | LLM-Studio traces, code-mode logs | Conversation UI + CSV reports | **20+ Prometheus counters; `MetricsSink` + `LearningSink` + `OutcomeSink` + `ShadowTelemetrySink`; semantic basis-code vocabulary makes traces SQL-queryable; replay harness classifies drift (`DECISION_KIND` / `BASIS_DRIFT` / `REFUSAL_CODE_DRIFT`)** |
| **Multi-agent** | Sub-flows (flow-of-flows, not agents) | Single assistant + external orchestration | Explicit Agents, growing MCP | Multi-*human*-agent (queues, SLAs) | **Single shared core with channel-conditioned voice/tokens — multi-channel ≠ multi-agent today** |
| **Cost / FinOps** | Opaque per-request (Google billing) | None (BYO LLM) | Built-in model routing | None | **Token budget per session (100k/day) in Redis; no $-conversion, no model routing, hard-coded Anthropic model** |
| **Learning model** | Manual training-phrase curation | `rasa interactive` (manual) | Thumbs-up/down capture | None | **`LearningSink` writes to Postgres `outcomes_store` — signal captured, no consumer reads it back** |
| **Adversarial defense** | DLP integration (add-on) | Rasa Pro PII redaction + injection guards | Redaction node | Redaction plugin | **Taint lattice blocks UNTRUSTED → SYSTEM mutations — but no prompt-injection scanner, no jailbreak detector, no output PII gate, no hallucination firewall** |
| **Identity** | Google Identity | SAML/SSO (Enterprise) | Workspace RBAC | Agent/Admin | **`actor.principal: string` (system, phone-hash, etc.) — no DID/VC, no signed-envelope attestation** |
| **Data sovereignty** | Google data centers | You own DB | Self-host or cloud SOC2 | You own DB (Postgres) | **Per-tenant `RuntimeContext`; Postgres + Redis + NATS self-hosted; no formal `SovereigntyPolicy` yet** |
| **Deployment** | Cloud-only (Google) | Docker/K8s, any cloud | Hybrid (binary or cluster) | Containerized monolith | **Node 22 + ESM + pnpm + Turborepo; Fastify 5; NATS + Redis + Postgres + Prisma + BullMQ; Sentry + Prometheus + PostHog** |
| **DX entry point** | Visual IDE | `rasa` CLI | `bp` CLI + Studio | Rails console + RSpec | **`ibx` CLI ("The One Rule"), atomic markdown task files, 10-rule CLAUDE.md constitution, 21 Packs (pack-orders, pack-payments, pack-whatsapp...)** |
| **Test scale** | "Test Agent" simulator | pytest + story tests | Visual + code-mode tests | RSpec | **1,006 TS files / 569 tests in ibatexas (~57% ratio); 296 / 138 in adjudicate; 1,122 workspace tests; 377/377 in core** |

### Commonalities across all 5 systems

- **Channel ingress + session state + outbound rendering** — every system has these three layers
- **Multi-channel by design** (WhatsApp + web at minimum)
- **Some pluggability boundary** (Rasa actions, Botpress integrations, Dialogflow webhooks, Chatwoot apps, adjudicate Packs/Sinks)
- **Async work via queues** (Sidekiq, Kafka, NATS, BullMQ)
- **Persistence trio** — relational store + cache + observability backend
- **Human handoff as first-class action**
- **PII redaction available as an add-on** (never structural for the four; structural for adjudicate via supersession reasons)
- **Admin audit logs** (who changed a flow) — but **none except adjudicate has per-decision audit records with structured basis codes**

### What makes ibatexas + adjudicate uniquely different

| Differentiator | Why it matters |
|---|---|
| **Kernel-as-interceptor on mutation path** | The other four arbitrate language; adjudicate arbitrates *action*. LLM is reduced to a semantic parser with zero state-mutation authority (CLAUDE.md Rule #9). |
| **6-valued Decision space** | `DEFER`, `REQUEST_CONFIRMATION`, `REWRITE` are not expressible in any of the four platforms. Replay-safe resume is a first-class primitive. |
| **Content-addressed audit + supersession chains** | Tamper-evident decision provenance. `auditHash` over canonicalized record + optional KMS/HSM signature. Causal lineage by `intentHash`, not JOIN-on-timestamp. |
| **Vocabulary-controlled basis codes** | Refusal taxonomy is a typed enum (11 categories). "Show all REFUSEs caused by `taint:propagation_violation` last 24h" is a structured query, not regex over logs. |
| **Fail-closed semantics** | `GUARD_PANIC` converts any thrown guard into SECURITY REFUSE. Ledger fail-closed (Redis down → REFUSE, not bypass). Kill-switch is an auditable operator action. |
| **Multi-tenant `RuntimeContext`** | Per-tenant kill switches, sinks, enforce config — explicit tenancy isolation rather than process-global state. |
| **Pure-deterministic kernel + side-effect-typed ports** | Replay is a first-class operation. Operator can re-adjudicate stored records against current policy to compute drift. |
| **Markdown-as-planning-artifact** | 21 atomic task files in `docs/adjudicate-migration/tasks/` each with Milestone / Effort / Blocks / Blocked-by / Owner / Files / Acceptance. Citeable, gated, file-pathed. |
| **Cross-repo release discipline** | `@adjudicate/core` Changesets-driven per-package CHANGELOGs; each entry justifies semver. The v1.1.0 release notes include adopter codemod snippets and rollback notes. |

---

## PART II — Current State Portrait

### What exists today (concise, by axis)

**Architecture (Axis 1)** — `adjudicate()` is a pure function over `(envelope, state, policy)` returning a `Decision`. The 7-step pipeline runs synchronously: kill → schema → state guards → taint → auth guards → business → policy default, with each phase short-circuiting on a non-null `Decision`. Patterns in use: Interceptor / Chain-of-Responsibility, tagged unions, Strategy (per-intent `PolicyBundle`), Ports & Adapters (`MetricsSink`/`LearningSink`/`OutcomeSink`/`ShadowTelemetrySink`/`AuditSink`), event-sourcing-lite (content-addressed audit). Style is functional with closures, ~zero classes. ibatexas integrates two ways: `withAdjudicate(envelope, state, policy, sink, executor)` chokepoint helper at `packages/domain/src/services/__shared__/with-adjudicate.ts`, and a `KernelExecutor` for XState-driven turns at `packages/llm-provider/src/kernel-executor.ts`.

**Governance (Axis 2)** — Kernel BLOCKS, doesn't merely audit. Six `Decision` kinds × four `Refusal` categories (SECURITY / BUSINESS_RULE / AUTH / STATE). Taint lattice on inputs. Audit v4 with `auditHash` + optional signature. LGPD: `customer.anonymize` intent DEFERs 24h then EXECUTEs → 7-surface scrub fan-out with `supersedes.reason: "lgpd_scrub"` (v1.1.0 made this distinct from the prior catch-all `replay`).

**Observability (Axis 3)** — `MetricsSink` 6 methods (4 required + 2 optional after v1.1.0), fanned out in `apps/api/src/plugins/kernel-metrics-sink.ts` (747 lines) to PostHog/NATS, Sentry breadcrumbs, and a `prom-client` Registry with 20+ counters (`kernel_decision_total`, `kernel_refusal_total{basis_category,basis_code}`, `kernel_audit_lag_seconds`, `kernel_intent_kind_coverage`). Replay harness already classifies drift across DECISION_KIND / BASIS_DRIFT / REFUSAL_CODE_DRIFT.

**Multi-agent / cost / learning (Axis 4)** — Single shared agent core. Channel is a tag (Web | WhatsApp), not an agent identity — both feed the same `runAgent` via the same `AgentContext`. Intent dispatch is in-process: `IntentDispatcher` consults a `Map<string, DispatchHandler>` of 14 deterministic-kernel-coverage entries. Token budget `100_000`/session/day in Redis at `llm:tokens:{sessionId}`. Only Anthropic SDK present in the codebase; model hard-coded to `claude-sonnet-4-6`. `LearningSink` writes to Postgres `outcomes_store` — **nothing reads it back**.

**Code health / DX (Axis 5)** — 1,006 TS files in ibatexas, 569 tests (~57% ratio). 22 TODO/FIXME in 1,006 files (exceptional discipline). 363 raw `prisma.*.{create,update,delete,upsert}` writes vs. 322 `adjudicate()` callsites — migration is **roughly halfway** by volume (refining the earlier "150+" mental model). Adjudicate: 1,122 tests pass workspace-wide; 377/377 in core. Tarball bloat is repo-wide — **14 of 21 publishable packages lack a `files` field** in `package.json`.

### Stale memory worth refreshing

The project memory says "~150+ mutation entrypoints bypass kernel today." Axis 5's actual measurement: **363 raw Prisma writes vs. 322 adjudicate calls**. The 150 number is stale (likely from when the migration started).

---

## PART III — The Gaps

Mapped to the visionary "Updated Visionary Architecture" five-row framing, plus three rows the original framing omitted:

| Missing layer | ibatexas + adjudicate today | Concrete gap |
|---|---|---|
| **Security / adversarial defense** | Taint lattice on payloads | No prompt-injection detector; no jailbreak scanner; no output PII gate; no hallucination firewall |
| **Scalability / multi-agent** | Single shared core, channel as tag | No A2A protocol; no MCP; one process, one model; channel ≠ agent |
| **Cost / FinOps** | Token count per session | No $-conversion; no per-model price table; no model routing; no monthly spend cap |
| **Debugging / chain-of-thought** | `Plan` snapshot in audit record | LLM call below the Plan is opaque — no prompt hash, no logprobs, no token-by-token reasoning |
| **Learning / RLAIF** | `LearningSink` emits to Postgres | No consumer reads it back; no curriculum proposer; no nightly auto-correction PRs |
| **Long-term memory (NEW)** | Session-scoped Redis state + customer Postgres rows | No retrieval over "what the customer mentioned 3 months ago"; audit ledger CAN serve this but has no retrieval interface |
| **Identity** | `actor.principal: string` | No DID, no signed envelopes from channels, no cryptographic attestation |
| **Code-health enforcement** | `withAdjudicate` chokepoint + atomic markdown tasks | No lint rule on raw `prisma.*` outside `withAdjudicate`; no shadow-mode bypass detector; no `ibx kernel coverage` burndown dashboard |

Plus from Axis 5: tarball bloat across 14 packages, 6 pre-existing failing tests, `PROJECT_STATE.md` stale by ~8 weeks, no `CONTRIBUTING.md` in ibatexas.

---

## PART IV — The Roadmap: adjudicate v2.x

Every proposal below is mapped to an existing seam. Nothing is greenfield; nothing breaks the determinism invariant.

### Tier 1 — Highest leverage, smallest surface

| # | Proposal | Seam it extends | Effort |
|---|---|---|---|
| **1** | **Lint-enforced kernel boundary** — custom ESLint rule: any `prisma.*.{create,update,delete,upsert}` outside `withAdjudicate(...)` callback is a hard error. Allowlist via `// kernel-bypass: <reason>` pragma → Sonar issue. | Static analysis; no kernel change | Days |
| **2** | **Shadow-mode bypass detector** — NATS subscriber watches Prisma middleware write events; cross-checks against audit-record stream. If a row mutates without a matching `AuditRecord` for that `intentHash` window → `bypass.detected` + GitHub issue with file/line. | New subscriber on existing NATS subjects; reuses Prisma middleware | Days |
| **3** | **Tarball hygiene CI gate** — `pnpm publish --dry-run` per package; assert `tarball.fileCount < N`; required globs (`dist/**`, `README.md`, `CHANGELOG.md`, `LICENSE`). Forces `files` field across all 14 missing packages — the v1.1.1 follow-up. | CI step; no runtime change | Hours |
| **4** | **`ibx kernel coverage` burndown** — counts raw-Prisma vs. adjudicated sites per package; prints chart; posts to Slack daily. Makes the 363→0 migration visible. | New `ibx` subcommand on existing CLI | Days |
| **5** | **Refresh `PROJECT_STATE.md`** — auto-regenerate from `audit-2026-05-24/CLOSEOUT-STATUS.md` on every commit; or retire and elevate CLOSEOUT-STATUS to root. | Docs + CI hook | Hours |

### Tier 2 — Governance v2 (semantic firewall + identity)

| # | Proposal | Seam it extends | Effort |
|---|---|---|---|
| **6** | **`InputGuard` phase (semantic firewall)** — new kernel phase before state/auth/taint/business. Implementations: prompt-injection classifier (Lakera/Protect AI/homegrown), homoglyph normalization, instruction-suppression detector. New basis codes `validation.PROMPT_INJECTION_DETECTED`, `JAILBREAK_PATTERN`, `INSTRUCTION_OVERRIDE`. | New phase + new basis vocabulary | Weeks |
| **7** | **`adjudicateOutput(response, context)`** — mirror Decision shape for response governance. PII detection (CPF/phone/email/CEP), forbidden-phrase enforcement, grounding-check failure → suppress. New envelope `kind: "llm.response"` so output decisions are queryable alongside mutation decisions. | Mirror existing `adjudicate` API; reuses Decision/Refusal types | Weeks |
| **8** | **Hallucination firewall via `groundingProof`** — every LLM response referencing a domain entity must carry `{ source, recordId, recordVersion, retrievedAt }`. Output adjudicator REFUSEs claims lacking proofs. New basis category `grounding`: `PROOF_PRESENT` / `MISSING` / `STALE` / `UNVERIFIABLE`. | New basis category | Weeks |
| **9** | **`INDIRECT` taint rank + field-level `TaintedValue<T>`** — extends the existing 3-level lattice; `EnvelopeProvenance.toolChain[]` records which read-tools fed each field. Closes the indirect-injection gap where a read-tool's output (product description, scraped page) flows back into the LLM. | Extends `taint.ts:12-34` | Weeks |
| **10** | **Cryptographic actor identity** — `actor: { principal: DID | "system"; attestation: SignedJWT }`. WhatsApp envelopes signed by gateway key; web envelopes by session attestor. New basis codes `auth.IDENTITY_UNATTESTED` / `ATTESTATION_INVALID`. | Extends `actor` shape and `auth` basis category | Weeks–months |
| **11** | **`SovereigntyPolicy` in `RuntimeContext`** — per-tenant `{region, allowedSinks, residencyAttestation}`. Kernel REFUSEs envelopes whose payload would route through a sink violating the policy. New basis `business.RESIDENCY_VIOLATION`. | Extends existing per-tenant `RuntimeContext` | Weeks |
| **12** | **Kernel-mediated tool execution** — every tool call (read AND write) routes through `adjudicate()`. Read tools get `kind: "tool.read.*"`. Closes the gap where attackers use a read tool (`customer.lookup_by_phone`) to enumerate. | New intent kinds; existing kernel | Months |
| **13** | **`AuditRedactor` at emit time** — tenant-configured field paths replaced with `sha256(salt + value)` before hashing/signing. Right-to-erasure on the ledger becomes "rotate the tenant salt." New supersession reason `lgpd_erasure_audit`. | Hook in `buildAuditRecord` (`audit.ts:177`) | Weeks |

### Tier 3 — Observability v2 (LLM chain-of-thought)

| # | Proposal | Seam it extends | Effort |
|---|---|---|---|
| **14** | **LLM-trace extension to `AuditPlanSnapshot`** — optional embed: prompt hash + redacted fragments, model + temperature, raw completion (PII-scrubbed), token logprobs. New basis category `llm` with codes `llm:tool_selected`, `llm:refusal_internal`, `llm:hallucination_detected`. Adopters opt in via `LLMTraceSink`. | Extends existing `AuditPlanSnapshot`; new sink alongside MetricsSink | Weeks |
| **15** | **Semantic drift detection** — continuous job over Postgres audit records computes per-(intent_kind, week) basis-code histograms; alerts on Jensen-Shannon divergence > threshold. New Prom gauge `kernel_basis_mix_drift{intent_kind}`. Possible *only* because of the closed basis vocabulary. | Reads existing audit table; new metric | Weeks |
| **16** | **Black Box Recorder UI** — operator console: headline + bullets + supersession chain visualizer + plan snapshot + LLM trace + `auditHash` verification badge + "Re-adjudicate against current policy" button (showing drift class inline). | Replay harness already exists; React shell only | Weeks |
| **17** | **Live decision stream** — WebSocket fanout from NATS `audit.*` subjects to the operator console, filterable by intent_kind / decision.kind / basis-category. | New WebSocket route on existing NATS | Days–weeks |
| **18** | **Localized refusal explanations to end users** — `DecisionExplanation` bullets exposed to customers ("Could not place order: a business rule blocked this — the requested quantity exceeded the configured cap"). | Existing `explain.ts` templates | Days |

### Tier 4 — Hive-mind + FinOps + teacher-loop (Axis 4 trilogy)

| # | Proposal | Seam it extends | Effort |
|---|---|---|---|
| **19** | **Hive-mind protocol** — promote `IntentEnvelope` to a wire format. Split `runAgent` into `whatsappAgent` + `chatAgent` *processes*. Adjudicate becomes the broker; `intentHash` already dedupes cross-process; `KERNEL_INTENT_DISPATCHED` becomes the hop marker. Shared Context Object = the audit record itself. | Promotes existing envelope; no new abstractions | Months |
| **20** | **`BudgetSink` (CFO module)** — pre-decision hook estimates cost (tokens × model price); post-decision records actuals. Policy phase REFUSEs on `business:rule_violated { reason: "budget_exceeded" }`. `synthesizePrompt` returns a `complexity` hint; `routeModel(complexity, plan, spendLeft)` replaces hard-coded model. Session `llm:tokens:{sessionId}` becomes monthly `llm:spend:{customerId}`. | New sink alongside `MetricsSink`/`LearningSink` | Weeks |
| **21** | **Teacher loop on existing `LearningSink`** — nightly Postgres job over `outcomes_store` clusters `(guardId, basisCodes, refuse→retry→execute)` tuples; emits curriculum proposals: "guard `escalateHighNoShowRate` refused 412 times; 38% had retry-success within 30s; recommend threshold adjustment." Pack authors review proposals in a dashboard. | Reads existing audit ledger; no schema change | Weeks |

### Tier 5 — Long-horizon (deep-context + federation)

| # | Proposal | Seam it extends | Effort |
|---|---|---|---|
| **22** | **`adjudicatePlan(IntentEnvelope[])`** — multi-step transactional adjudication; emits one `EXECUTE` only when every step would individually `EXECUTE`. Supersession links the batch. This is the "AI conductor" leap: the LLM proposes a multi-step plan, the kernel ratifies the whole plan before any side effect runs. | Builds on existing `adjudicate()` | Months |
| **23** | **Federated `RuntimeContext` pods** — network-addressable per-region pods. Audit records gossip via content-addressed CRDT (auditHash is already a Merkle identity). Adopters self-host one pod per region for data sovereignty. | Promotes existing per-tenant context to network-addressable | Months–quarters |
| **24** | **Replay-as-API** — first-class `replay(auditRecord, freshPolicy)` returning `{ original, replayed, divergence }`. Operators run policy diffs against historical traffic before deploying. The harness exists as CLI; this is the operator-facing API + UI. | Promotes existing `audit/src/replay.ts` | Weeks |
| **25** | **Long-term memory layer** — retrieval interface over the audit ledger keyed by `customerId`. "What did this customer mention about their cat 3 months ago" becomes a structured query. Implements the user's "Deep Context" vision without adding a new datastore. | Reads existing audit table; new retrieval port | Weeks |
| **26** | **Auto-curriculum from production refusals** — overnight job clusters recent refusals by `(intent.kind, refusal.code)`; proposes property test asserting "envelopes of shape X always refuse with code Y"; opens PR. Kernel teaches its own test suite. | Reuses outcomes_store; new GitHub bot | Weeks |
| **27** | **Executable spec docs** — convert ADRs and concept docs to `.mdx`/literate-test files where code blocks run as part of `vitest`. Docs can never drift. | Vitest + mdx; no kernel change | Weeks |
| **28** | **Drop `RuntimeContext` singleton fallback** — make `RuntimeContext` mandatory; remove the default-context fallback. Forces multi-tenant cleanliness from day one of v2. | Hardening of existing primitive | Weeks |

---

## PART V — Suggested Next Moves

Three time horizons. None require external dependencies; all are achievable on the existing kernel.

### This week (low-risk, high-visibility)

1. **Ship v1.1.1 with `files` field across all 14 packages** (Tier-1 #3) — closes the tarball-bloat hygiene gap; tiny diff, big win for adopters.
2. **Refresh `PROJECT_STATE.md`** or retire it to `CLOSEOUT-STATUS.md` (Tier-1 #5) — kills 8 weeks of staleness.
3. **Update the project memory** — change "~150+ mutation entrypoints bypass kernel" to the measured "363 raw Prisma writes vs. 322 adjudicate calls, ~half done."

### This quarter

4. **Lint rule + shadow bypass detector** (Tier-1 #1 + #2) — kills the chance of regression while the 363 long tail is being mechanically migrated.
5. **`ibx kernel coverage` burndown command** (Tier-1 #4) — make the migration progress visible to stakeholders weekly.
6. **`BudgetSink` (Tier-4 #20)** — easiest of the three Axis-4 pillars; adds $-tracking + monthly cap with zero kernel changes (just a new sink).
7. **Teacher loop MVP** (Tier-4 #21) — closes the "signal captured, no consumer" gap; nightly job + Slack post; no schema change.
8. **Localized refusal explanations** (Tier-3 #18) — already-templated, just needs a public surface; immediate UX win.

### This year (kernel v2.0)

9. **Semantic firewall** (`InputGuard` + `adjudicateOutput` + `groundingProof`, Tier-2 #6–#8) — the highest-impact governance leap; turns the kernel from "mutation gate" into "full AI firewall."
10. **`INDIRECT` taint** (Tier-2 #9) — closes the indirect-injection gap that single-stage prompt-injection scanners miss.
11. **LLM-trace observability** (Tier-3 #14–#16) — adds chain-of-thought to the existing semantic substrate so the full LLM → kernel → execution chain is one queryable trace.
12. **Hive-mind decomposition** (Tier-4 #19) — split `runAgent` into per-channel processes; kernel as broker. Foundation for true multi-agent.
13. **DID-based actor identity** (Tier-2 #10) — moves `actor.principal` from "string the subscriber claims" to "signed attestation the kernel verifies."

### Stretch (kernel v3.0 / category-defining)

14. **`adjudicatePlan` for multi-step transactions** (Tier-5 #22) — the visionary "AI Conductor" primitive.
15. **Federated RuntimeContext pods** (Tier-5 #23) — sovereign data pods via existing per-tenant primitive.
16. **Long-term memory retrieval over the audit ledger** (Tier-5 #25) — the "Deep Context" vision, built on existing data.

---

## Closing Note

Adjudicate is already the **right shape** for the visionary "System 3" — kernel-as-interceptor with typed decisions and a content-addressed audit ledger is exactly what a "Runtime Governance Engine / AI Firewall" requires. The 28 proposals above are about *widening the surface* (output governance, semantic firewall, LLM-trace, FinOps, hive-mind, learning loop, identity, memory) — never about *replacing the core*.

The four platforms ranked by closest analog:
- **Closest existing peer in any one dimension:** Botpress (model routing, MCP, code-mode sandbox).
- **Closest existing peer in governance philosophy:** Rasa Pro (code-as-policy + injection protection — but unstructured).
- **Closest existing peer in adoption posture:** None — the kernel-as-mutation-interceptor pattern is genuinely outside the chatbot category.

The fundamental category mismatch is also the fundamental opportunity: **no chatbot platform ships with a determinism-grade audit ledger, a vocabulary-controlled refusal taxonomy, and a six-valued decision space**. Adjudicate already does. The visionary roadmap is the rest of the story written in the same idiom.

---

## Source File References

For implementers picking up any proposal above:

- `adjudicate/packages/core/src/kernel/adjudicate.ts` — the 7-phase pipeline (`adjudicate.ts:97-103`, `_adjudicateImpl` at `165-322`, `guardPanicRefusal` at `339-380`)
- `adjudicate/packages/core/src/decision.ts:19-25` — six `Decision` kinds
- `adjudicate/packages/core/src/refusal.ts:11` — four refusal categories
- `adjudicate/packages/core/src/audit.ts:86-142` — `AuditRecord` v4; `auditHash` at `211-216`; `replayEnvelopeFromAudit` at `271-285`
- `adjudicate/packages/core/src/basis-codes.ts:25-104` — 11-category vocabulary; `KERNEL_INTENT_DISPATCHED` at `102`
- `adjudicate/packages/core/src/explain.ts:195-275` — explanation templates; `narrateSupersession` at `130-146`
- `adjudicate/packages/core/src/kernel/runtime-context.ts:209-228` — per-tenant container
- `adjudicate/packages/core/src/kernel/metrics.ts:27-51` — `MetricsSink` interface; optional-method warn at `115-123`
- `adjudicate/packages/core/src/kernel/learning.ts:79-117` — `LearningSink` interface; `adjudicateAndLearn` at `210`
- `adjudicate/packages/core/src/taint.ts:12-34` — taint lattice
- `adjudicate/packages/audit/src/supersession-chain.ts` — chain walker
- `adjudicate/packages/audit/src/replay.ts` — drift classification
- `ibatexas/apps/api/src/plugins/kernel-metrics-sink.ts` — fan-out adapter (PostHog, Sentry, Prometheus)
- `ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — Pack registration + bootstrap
- `ibatexas/packages/domain/src/services/__shared__/with-adjudicate.ts` — migration chokepoint
- `ibatexas/packages/domain/src/services/customer.service.ts:462-1184` — LGPD `anonymizeCustomerFromEnvelope` + `emitScrubAuditRecords` fan-out
- `ibatexas/packages/llm-provider/src/agent.ts:60` — `runAgent` (single shared core today)
- `ibatexas/packages/llm-provider/src/intent-dispatcher.ts:108-170` — `IntentDispatcher` deterministic-coverage map
- `ibatexas/packages/llm-provider/src/llm-responder.ts:699-849` — session token tracking
- `ibatexas/packages/llm-provider/src/kernel-executor.ts:18-19` — XState turn integration
- `ibatexas/CLAUDE.md` — 10-rule constitution (Rule #9: kernel-is-always-authoritative)
- `adjudicate/packages/core/RELEASE-1.1.0.md` — v1.1.0 adopter codemod + rollback notes

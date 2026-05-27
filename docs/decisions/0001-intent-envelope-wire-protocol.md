# ADR-001: `IntentEnvelope` as the runtime ↔ kernel wire protocol

- **Status:** Proposed
- **Date:** 2026-05-26
- **Deciders:** Bruno Rodolpho, claustrum core team
- **Consulted:** @adjudicate/core maintainers
- **References:**
  - `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/audit.ts` (canonical TS types: `IntentEnvelope`, `Decision`, `AuditRecord`)
  - `/Users/thaisrodolpho/projects/adjudicate/packages/core/src/basis-codes.ts` (basis-code vocabulary)
  - PART I §"The Adjudicator port" of master plan
  - ADR-005 (Runtime/Kernel Layer Split) — the architectural declaration this ADR realises

## Context

`@claustrum/core` orchestrates probabilistic cognition (LLM planning, memory retrieval, prompt synthesis) and submits proposed mutations to `@adjudicate/core` for deterministic adjudication. Today, `IntentEnvelope` is a TypeScript interface exported only from `@adjudicate/core`. Two repos importing the same TS type by file path is a fragile coupling — once `@claustrum/*` ships to npm, three coordination problems emerge:

**First, schema evolution.** Adjudicate is on `INTENT_ENVELOPE_VERSION = 2` and has already burned one schema break (v1 → v2 added `nonce` as a hash input). The audit ledger is at `AUDIT_RECORD_VERSION = 4`. Adding a field is currently a coordinated TS-type bump across both repos.

**Second, replay across repo versions.** A claustrum v0.3.0 envelope landing in an audit ledger that adjudicate v1.2.0 reads back must hash-match months later. Adopters running `adjudicate.replayEnvelopesByCustomerId()` need stable bytes regardless of which package version produced the envelope.

**Third, language-portability.** While both packages are TypeScript today, the envelope is a wire format. A future Python-based agent or Rust-based grounding service must construct envelopes adjudicate accepts. TS interfaces are not a portable contract.

## Decision

We treat `IntentEnvelope` as a **versioned wire protocol with protobuf-style additive discipline**, not as a TS-only type:

1. **Schema version is required and explicit.** The `version: 2` literal is part of the hash input (`hashInput = { version, kind, payload, nonce, actor, taint }`). Bumping the version is a deliberate ledger-shape break, not a refactor.

2. **All new fields are optional.** Following `AuditRecord`'s v1→v4 evolution pattern: every field added past v2 (e.g., a future `groundingProof`, `agentId`, `tenantId`) is marked optional and absent in v2-shaped records. Readers branch on `record.version` only when they need post-v2 fields. This is documented as a hard rule in `@claustrum/core`'s contributing guide.

3. **Reserved field-name registry.** Maintain `docs/decisions/0001-reserved-fields.md` (forthcoming companion doc) listing every field name that has ever appeared on an envelope plus its semantic. Removing or repurposing a field is forbidden — protobuf-style. The current reserved set is `{ version, kind, payload, createdAt, nonce, actor, taint, intentHash, supersedes, groundingProof? }`.

4. **`intentHash` derivation is canonical and stable.** Hash inputs in canonical-JSON ordering: `(version, kind, payload, nonce, actor, taint)`. `createdAt` is explicitly excluded so retries with identical nonce produce identical hashes regardless of wall-clock. `intentHash` itself is excluded from its own hash input (self-reference). This is the existing `sha256Canonical` behavior in adjudicate's `envelope.ts` — claustrum inherits it as the cross-language contract.

5. **JSON Schema generation.** `@claustrum/core` ships `schemas/intent-envelope.v2.json` generated from the TS type. Non-TS consumers (future Python/Rust adapters) validate against the JSON Schema, not the TS file.

6. **Peer-dep pin on `@adjudicate/core` by major version.** `@claustrum/core` declares `@adjudicate/core` as a peerDependency pinned to `^1.0.0` (or whatever majors envelope v2 is stable in). Bumping `@adjudicate/core` to a major that ships envelope v3 requires a coordinated `@claustrum/core` major bump.

## Consequences

**Positive:**
- Claustrum can ship envelope-producing code without re-implementing the type — it imports `IntentEnvelope` + `buildEnvelope` from `@adjudicate/core` and treats them as the protocol surface.
- Audit ledgers from any claustrum version remain replayable by future adjudicate versions; basis-code vocabulary grows additively.
- The JSON Schema unblocks third-party language SDKs without forcing a TS-only ecosystem.
- The "envelope is a wire protocol, not a TS struct" framing is enforced by reviewers — additions are PRs to this ADR before they are code.

**Negative:**
- Protobuf-style discipline is enforced by code-review, not by tooling. A reviewer must catch a non-additive change. Mitigated by a CI step that diffs the JSON Schema for breaking shape changes.
- Field-name conflicts can occur if claustrum and adjudicate evolve independently. Resolved by ADR-001 being co-owned: both repos' maintainers approve schema changes.
- Field-bloat risk over time. Mitigated by an annual review pass — fields unused for >2 minor releases get marked deprecated, never removed.

**Neutral:**
- Until envelope v3 ships, this ADR is documentation-only — no code changes. Its value is the social contract it establishes before the second repo starts producing envelopes at scale.

# DEFER Troubleshooting Runbook

> Runtime-side runbook extracted from the ibatexas `docs/ops/runbooks/kernel-operations.md` document. The original runbook covered both kernel operations (Pack version updates, kernel replay, audit-postgres migrations, incident response) and runtime DEFER troubleshooting. **The kernel/audit-postgres operational sections stay in the ibatexas adopter** (or move into the `@adjudicate/*` documentation tree). Only the **DEFER troubleshooting** section — the runtime-side runbook for un-sticking parked envelopes — migrates to claustrum.

The kernel's `DEFER` decision parks an envelope until a signal fires that lets the runtime resume it. This is how `@claustrum/core` handles "wait for the user's confirmation," "wait for payment to settle," "wait for an external webhook," and similar asynchronous patterns without holding a hot turn open.

This runbook covers: how DEFER works at the runtime layer, where parked envelopes live, how to recover a stuck DEFER, and what a healthy DEFER pipeline looks like in production.

---

## What DEFER does at the runtime layer

When `adjudicate()` returns `kind: "DEFER"`, the runtime:

1. Persists the envelope into the session's `deferredEnvelopes` collection (see [`docs/ops/session-and-state-keys.md`](./session-and-state-keys.md)).
2. Records `deferUntil` — either a wall-clock deadline or a named signal (e.g. `payment.confirmed`).
3. Records the envelope's `intentHash` so it can be matched back when the signal fires.
4. Returns `{ kind: "deferred" }` to the conductor; the conductor finishes the turn (telemetry, memory.observe).

When the awaited signal fires (a NATS event, a webhook callback, a wall-clock deadline elapsing), a runtime-side **defer-resolver** subscriber:

1. Finds the parked envelope(s) keyed by signal name or `sessionId`.
2. Constructs a fresh envelope with `supersedes: { intentHash, reason: "<signal-name>_resolved" }`.
3. Submits to `adjudicate()` again — the kernel re-runs the policy with current state.
4. The runtime acts on the new `Decision` and renders the resulting response back to the user via their channel.

**Key invariant.** The runtime does **not** bypass `adjudicate()` on resume. The signal is the trigger; the kernel is still the authority on whether the deferred action is now legal.

`@claustrum/core` consumes `@adjudicate/runtime`'s `resumeDeferredIntent` and `deadlinePromise` helpers for this pipeline — it does not duplicate them.

---

## Where parked envelopes live

| Layer | Storage | Notes |
|---|---|---|
| **Hot path** | Redis `defer:pending:{sessionId}` (and similar adopter-defined key) | Indexed by sessionId for fast resume. Hash payload is the envelope JSON + parking metadata (`deferUntil`, signal name, intentHash). |
| **Session state** | `Session.deferredEnvelopes` array | The `SessionStore` persists this alongside `pendingConfirmations`. On session resume after a long gap, the working-memory consolidator skips deferred envelopes (they're not user-visible state). |
| **Audit trail** | `intent_audit` Postgres table (kernel-owned) | Every DEFER decision is itself an audit record. When the resume happens, the new envelope's audit record carries the `supersedes` link back to the original DEFER. |

The hot-path Redis key is **fail-closed** — if Redis is unreachable, DEFER cannot park, and `adjudicate()` REFUSEs with `code: "ledger_unavailable"`. This is intentional (the kernel does not silently drop a deferred action).

---

## Operator recovery — un-sticking a stuck DEFER

A "stuck DEFER" is a parked envelope whose expected signal never fired (subscriber failed, NATS partition outage, external webhook never came back). To resume manually:

```bash
# Manually resume a stuck DEFER for a given session
ibx kernel defer resume <sessionId>

# Dry-run with a specified signal — useful for debugging
ibx kernel defer resume <sessionId> --signal pix.confirmed --json
```

The CLI:

1. Loads the parked envelope from Redis.
2. **Verifies the parked-envelope hash** (fail-closed on tamper — a hash mismatch means someone modified the parked envelope mid-flight).
3. Publishes a synthesised signal NATS event (e.g. `payment.status_changed`) so the live `defer-resolver` subscriber picks it up.
4. Does **not** bypass `adjudicate()` — kicks the existing resume pipeline; the kernel still adjudicates the resumed envelope against current policy.

Note: in claustrum-based adopters the CLI name may differ (the historical command `ibx` is ibatexas-specific). The equivalent in a generic claustrum adopter is `claustrum defer resume <sessionId>` once the CLI is wired up.

---

## Healthy DEFER pipeline — what to expect

- **DEFER decisions per session** should be low (<5/day for typical adopters). High DEFER rate suggests business rules are mis-aligned with user behaviour (e.g. policy demands confirmation for actions users do routinely).
- **Average time to resume** should be bounded — if signals routinely take hours, consider whether the signal is wrong (an explicit confirmation flow may be more appropriate than DEFER).
- **Re-adjudication outcomes** on resume:
  - `EXECUTE` (expected) — signal fired, conditions now met, action proceeds.
  - `REFUSE` (acceptable) — conditions changed; user is notified.
  - `DEFER` (smell) — re-deferring means the resumption isn't actually resolving the gate. Investigate.
  - `REQUEST_CONFIRMATION` (rare) — DEFER → CONFIRM ladder suggests the policy graph isn't quite right.

---

## Failure modes

| Symptom | Diagnosis | Recovery |
|---|---|---|
| Envelope parked but signal never received | Subscriber down, NATS partitioned, external webhook lost | `ibx kernel defer resume <sessionId>` after fixing the upstream issue. |
| Resume fails with hash mismatch | Parked envelope was modified mid-flight (should never happen; suggests Redis tampering or a bug) | Investigate. Do not auto-recover. The envelope is **not safe to resume**. |
| Resume re-DEFERs | Policy gate isn't resolving; you have a state-machine bug or a stuck precondition | Read the resumed `Decision`'s `basis` codes. They name the gate. |
| Redis outage during DEFER | `adjudicate()` REFUSEs with `ledger_unavailable` | Restore Redis. Envelopes that never parked are not silently lost — the user sees a refusal. |
| Session expires before signal fires | The session's `lastActivityAt` aged past TTL; the deferred envelope went with it | Adopter policy: extend session TTL for sessions with parked envelopes, or surface a "we lost track of your in-flight action" experience. |

---

## Long-lived sessions and DEFER

WhatsApp conversations can last weeks. A DEFER might park an envelope on day 1 and the resolving signal fires on day 5. This is supported but requires care:

1. **Session TTL** must be longer than `deferUntil` (or refreshed when an envelope is parked).
2. **Working-memory consolidation** during session-resume should preserve `deferredEnvelopes` even when collapsing older turns.
3. **Resume pipeline** must verify the parked-envelope hash on resume — long-lived parking is a longer window for tampering.

See [`docs/architecture/design/whatsapp-state-builder.md`](../architecture/design/whatsapp-state-builder.md) for the long-lived WhatsApp resumption pattern that interacts with DEFER.

---

## Cross-references

- [ADR-004 (Intent-Gated Execution)](../decisions/0004-intent-gated-execution.md) — the 6-variant `Decision` shape including DEFER.
- [`docs/architecture/design/runtime-kernel-layer-split.md`](../architecture/design/runtime-kernel-layer-split.md) — why DEFER is a kernel-emitted decision the runtime acts on, not a runtime-side mechanism.
- [`docs/ops/session-and-state-keys.md`](./session-and-state-keys.md) — `defer:pending:{sessionId}` and related keys.
- `@adjudicate/runtime` package — provides `resumeDeferredIntent` and `deadlinePromise` helpers `@claustrum/core` consumes.
- **Historical:** the kernel-side sections of the ibatexas `docs/ops/runbooks/kernel-operations.md` (Pack version updates, `ibx kernel migrate`, `ibx kernel replay`, audit-postgres incident response) remain in the ibatexas adopter docs.

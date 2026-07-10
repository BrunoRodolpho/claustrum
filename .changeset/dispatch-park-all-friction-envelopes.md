---
"@claustrum/core": patch
---

dispatch parks ALL friction-verb envelopes, not just envelopes[0] — BKL-063.

`adjudicatePlan` is transactional (kill-all-or-execute-all), so a plan-level
friction verd (REQUEST_CONFIRMATION / DEFER / ESCALATE) gates EVERY envelope.
`dispatchDecision` previously parked/queued only `envelopes[0]` (`pickEnvelope`),
so the second envelope of a compound customer message silently VANISHED on
resume (ibatexas ground-truth L4 sibling). Dispatch now parks/queues EVERY
envelope, in plan order, each keyed by its own `intentHash`:

- REQUEST_CONFIRMATION parks every envelope as a pending confirmation;
- DEFER parks every envelope as deferred (one shared `deferUntil` for the plan);
- ESCALATE queues every envelope to the HandoffPort.

Envelopes are deduped by `intentHash` (no double-park). The single-envelope path
is byte-identical — same park/queue args and the same `{ envelope }` result
shape. Each friction result now also carries an optional `envelopes` field (the
full ordered set, present only when more than one was parked) for observability;
resume itself reads `session.pendingConfirmations` / `deferredEnvelopes`, so the
per-envelope state is preserved and each parked envelope resumes independently. A
friction verb still executes nothing (no mutation runs).

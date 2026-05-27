# @example/healthcare-stub

claustrum reference application demonstrating the park / resume
confirmation flow against a healthcare-shaped tool surface.

## NOT HIPAA-compliant — structural demo only

This example exists to show how a real adopter would compose claustrum
around a confirmation-gated workflow. It is **not** a production
healthcare deployment template:

- No PHI handling boundary
- No Business Associate Agreement scaffolding
- No regulator-grade audit retention policy
- No data-residency partition
- No clinical safety review on the toy responder text

Production healthcare deployments need every box on the HIPAA checklist
(plus state-level requirements) before going live. Use this as a
mechanism sketch only.

## What it shows

- Two `requiresConfirmation: true` capabilities:
  `appointment.schedule` (medium risk) and
  `prescription.refill_request` (high risk).
- A custom `ConfirmingAdjudicator` that returns `REQUEST_CONFIRMATION`
  on first observation of an envelope and `EXECUTE` only after the
  envelope's `intentHash` has been pre-confirmed.
- Two `handleTurn` calls back-to-back:
    - Turn 1: user asks to schedule. Decision is `REQUEST_CONFIRMATION`;
      the session parks the envelope.
    - Turn 2: user replies "yes". The runtime re-adjudicates and the
      adjudicator returns `EXECUTE`; the tool runs.

## Run

```sh
pnpm install
pnpm --filter @example/healthcare-stub dev
```

Expected output:

```
turn 1
  decision.kind : REQUEST_CONFIRMATION
  response      : Please confirm: appointment.schedule. Reply "yes" to proceed.
turn 2
  decision.kind : EXECUTE
  response      : Action confirmed and executed.
```

# @claustrum/core

## 0.3.1

### Patch Changes

- d3f7e41: Add the Q6a claims-validation loop to the conductor: the INVESTIGATE + CLAIMS-VALIDATE stages (`runInvestigate`, `runClaimsValidate` from `./claims-loop`) and the `ClaimPlannerPort`/`ClaimPlannerInput` + `InvestigatorPort`/`InvestigateInput` ports, threading the `@adjudicate/core@1.6.0` Evidence Ledger through `handle-turn`. The 13 existing conductor ports are unchanged — purely additive (a Capsule seam carries the new stages), so existing consumers (e.g. ibatexas pinned to the frozen ports) are unaffected.

## 0.3.0

### Minor Changes

- Widen `ChannelKind` with `"system"` (non-conversational trigger ingress for
  server-resident managed agents) and add the DR-4 per-session lock-key
  strategy.
  - `ChannelKind = "whatsapp" | "web" | "system"` — the canonical union in
    `@claustrum/core` ports/channel. The two parallel literal unions
    (`channel-whatsapp` `AttestContext.channel`, `cli` replay `TurnFile.channel`)
    now reference the canonical type instead of duplicating it. No exhaustive
    switches on `ChannelKind` exist (verified), so the widening is additive.
  - `ConductorOptions.lockKeyStrategy?: LockKeyStrategy` — optional derivation
    of the per-session lock KEY from the `openCapsule` input. Default
    (`defaultLockKey`) is byte-identical to previous behavior
    (`` `${channel}:${customerId}` ``; `input.sessionKey` ignored for locking).
    New exported `sessionKeyAwareLockKey` honors an explicit `sessionKey` as
    the lock key, so a trigger turn (channel `"system"`) can name the
    entity-scoped serialization domain (e.g. `web:<customerId>`) and strictly
    serialize against that customer's chat turns across processes under a
    distributed `SessionLock` (e.g. `PostgresAdvisorySessionLock`).

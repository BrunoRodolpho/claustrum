# @claustrum/core

## 0.5.0

### Minor Changes

- 4815c5f: Thread the #8 decomposer ownership signal to the claims renderer: new optional
  `ActiveResourcesForTurn` seam on the Capsule/Conductor (mirroring
  `ClaimsKernelDepsForTurn`) derives the turn's active owner-scoped resources from
  the threaded Evidence Ledger + the AUTHENTICATED customerId — never
  session/model ids — and `handleTurn` passes the result to the renderer as the
  new `ClaimsRenderContext.activeResources` (`ActiveResourceRef[]`). All additive
  and optional: unwired conductors/renderers are byte-identical. This is the
  pre-flag-flip gate for the adopter-side §O#15 required-claim decomposer's
  ownership companions (BKL-004).

## 0.4.0

### Minor Changes

- a005e6f: Render-from-claims seam (Plan 1 Phase 3 / SDD §B · §J.6 · §O#3 · §Q.7): the
  cognitive loop can now render the customer-facing reply DETERMINISTICALLY from the
  validated claims — the "claims-not-prose" thesis at the loop level.
  - New optional port `ClaimsRendererPort` (`render(claims: ClaimsKernelResult) →
{ text }`) + `ClaimsRenderResult`, exported from the barrel. The deterministic
    template-filler itself lives DOWNSTREAM (ibatexas `renderer-from-claims`); this
    is the seam contract only.
  - New optional `Capsule.claimsRenderer` + `ConductorOptions.claimsRenderer`,
    threaded straight through `createConductor` (like the other claims seams).
  - `handleTurn` new stage 6a (RENDER-FROM-CLAIMS): when CLAIMS-VALIDATE produced a
    `ClaimsKernelResult` AND `claimsRenderer` is wired, the reply TEXT is rendered
    from the claims, SUPERSEDING the model draft's text (artifacts/usage still come
    from the draft; the rendered text still passes the OUTPUT FIREWALL). Not a
    mutation verb — no `adjudicate()` call, so the once-per-turn invariant holds.

  ADDITIVE + BYTE-IDENTICAL when unwired: with no `claimsRenderer` (or no claims
  result), the legacy model-responder reply stands unchanged. The frozen ports are
  extended, never broken.

- 49f9530: Track-A / W6 — the per-turn CLAIMS-VALIDATE reconciliation seam (SDD §F / §G/§E;
  the W5b conductor seam). Closes the two loop-side defects that demoted valid
  owner-scoped first-party claims to UNKNOWN under the published Claims Kernel,
  WITHOUT touching the kernel (the kernel guards are correct and stay).
  - New `ConductorOptions.claimsKernelDepsForTurn?` + `Capsule.claimsKernelDepsForTurn?`
    (type `ClaimsKernelDepsForTurn`, exported from the barrel): an optional per-turn
    builder that rebuilds the Claims-Kernel deps (`owns` / `outcomeConfirmed`) from
    THIS turn's threaded read-only Evidence Ledger + the AUTHENTICATED `customerId`.
    The conductor previously rebuilt ONLY `now` per turn (R2a), so the process-wide
    boot-empty owner set left every owner-scoped ORDER/PAYMENT claim REFUSED even
    for its legit owner. Threaded straight through `createConductor` like the other
    claims seams. IDOR stays closed: the adopter derives the owned set ONLY from
    owner-scoped reads that returned PRESENT — never a session/model id.
  - `CLAIMS-VALIDATE` now runs a PER-TURN RECONCILIATION between the planner and the
    pure kernel (post-INVESTIGATE / pre-`runClaimsKernel`), adjusting only kernel
    INPUTS (never a verdict, never a skipped conjunct — the full §5 predicate still
    runs): 1. **Freshness floor (clock-ordering fix).** The conductor captures the per-turn
    `now` at openCapsule (turn START) BEFORE the investigator stamps each read's
    `fetchedAt = Date.now()`; a same-turn first-party read could thus carry
    `fetchedAt > now` → the kernel's correct negative-age guard rejected it → a
    valid this-turn read demoted to UNKNOWN. CLAIMS-VALIDATE now FLOORS `now` up
    to the newest SAME-TURN first-party read's `fetchedAt`.

           GENERALIZED (this revision) from `sourceMode === "live"` ONLY to ALL PRESENT
           first-party (`originProvenance === "FIRST_PARTY"`) entries whose `fetchedAt`
           is AFTER the frozen turn-start `now` (= reads taken THIS turn), regardless of
           live-vs-cacheable. The live-only floor regressed STORE_OPEN_NOW: its schedule
           evidence is `sourceMode: "cache"` (freshnessPolicy `{cacheable, ttl:3600}`),
           stamped `fetchedAt ≈ now + ε` AFTER the conductor froze `now`, so the floor
           never raised `now` → the kernel cacheable check (`age = now - fetchedAt; age

           > = 0 && age <= ttl`) saw `age < 0`→ UNKNOWN. The predicate is`fetchedAt >
           > frozenNow`, so a genuinely-STALE cached entry (`fetchedAt ≪ now`) is EXCLUDED

    → it can NEVER raise the floor → it still demotes to UNKNOWN (no masking,
    unit-tested). The floor only RAISES `now`to absorb same-turn clock skew; the
    kernel negative-age guard is NOT relaxed (it stays in adjudicate).`must_read_this_turn` (clock-independent) is unaffected.

        2. **Per-turn owns** — invokes `claimsKernelDepsForTurn` (above) when wired.
        3. **Ledger-exact value derivation** — binds a still-undefined bound candidate's
           `value` to its PRESENT first-party ledger entry so C6 compares ledger-sourced
           scalars (the model authors NO value — it emits the type tag only). A
           cross-owner / absent read stays undefined → C6 ABSTAINs → honest UNKNOWN.

  ADDITIVE + BYTE-IDENTICAL when unwired: with no `claimsKernelDepsForTurn` and no
  same-turn live reads to floor, the stage is unchanged. Requires `@adjudicate/core`

  > = 1.8.0 (the C6 `valueBinding` surface this reconciliation reads). This minor
  > changeset bumps `@claustrum/core` 0.3.x -> 0.4.0 (the real publish target).

## 0.3.2

### Patch Changes

- 6ff097c: R2 claims-runtime fixes (built on the SDD claims runtime):
  - R2a: per-turn freshness clock seam — unfreeze the boot-captured `now` so evidence freshness is evaluated against the turn's clock, not process start.
  - R2b: greeting turns no longer attach a spurious `UNKNOWN` claim.

  No public API change; consumes `@adjudicate/core` `^1.6.0` (unchanged — keeps the package consumable by downstream pinned to core 1.6.0).

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

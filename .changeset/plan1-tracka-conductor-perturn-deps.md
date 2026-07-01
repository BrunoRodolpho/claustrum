---
"@claustrum/core": minor
---

Track-A / W6 — the per-turn CLAIMS-VALIDATE reconciliation seam (SDD §F / §G/§E;
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
  runs):
  1. **Freshness floor (clock-ordering fix).** The conductor captures the per-turn
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
     >= 0 && age <= ttl`) saw `age < 0` → UNKNOWN. The predicate is `fetchedAt >
     frozenNow`, so a genuinely-STALE cached entry (`fetchedAt ≪ now`) is EXCLUDED
     → it can NEVER raise the floor → it still demotes to UNKNOWN (no masking,
     unit-tested). The floor only RAISES `now` to absorb same-turn clock skew; the
     kernel negative-age guard is NOT relaxed (it stays in adjudicate).
     `must_read_this_turn` (clock-independent) is unaffected.
  2. **Per-turn owns** — invokes `claimsKernelDepsForTurn` (above) when wired.
  3. **Ledger-exact value derivation** — binds a still-undefined bound candidate's
     `value` to its PRESENT first-party ledger entry so C6 compares ledger-sourced
     scalars (the model authors NO value — it emits the type tag only). A
     cross-owner / absent read stays undefined → C6 ABSTAINs → honest UNKNOWN.

ADDITIVE + BYTE-IDENTICAL when unwired: with no `claimsKernelDepsForTurn` and no
same-turn live reads to floor, the stage is unchanged. Requires `@adjudicate/core`
>= 1.8.0 (the C6 `valueBinding` surface this reconciliation reads). This minor
changeset bumps `@claustrum/core` 0.3.x -> 0.4.0 (the real publish target).

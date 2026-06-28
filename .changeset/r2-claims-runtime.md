---
"@claustrum/core": patch
---

R2 claims-runtime fixes (built on the SDD claims runtime):

- R2a: per-turn freshness clock seam — unfreeze the boot-captured `now` so evidence freshness is evaluated against the turn's clock, not process start.
- R2b: greeting turns no longer attach a spurious `UNKNOWN` claim.

No public API change; consumes `@adjudicate/core` `^1.6.0` (unchanged — keeps the package consumable by downstream pinned to core 1.6.0).

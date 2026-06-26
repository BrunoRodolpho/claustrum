---
"@claustrum/core": patch
---

Add the Q6a claims-validation loop to the conductor: the INVESTIGATE + CLAIMS-VALIDATE stages (`runInvestigate`, `runClaimsValidate` from `./claims-loop`) and the `ClaimPlannerPort`/`ClaimPlannerInput` + `InvestigatorPort`/`InvestigateInput` ports, threading the `@adjudicate/core@1.6.0` Evidence Ledger through `handle-turn`. The 13 existing conductor ports are unchanged — purely additive (a Capsule seam carries the new stages), so existing consumers (e.g. ibatexas pinned to the frozen ports) are unaffected.

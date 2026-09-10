# Change (stretch): Cross-tenant reuse with a second app variant

## Why
Directly demonstrates the Section 3.7 story instead of only describing it: one artifact
recorded on the base app applied to a re-branded, re-labeled variant with an overlay.

## What changes
Target app `variant=tenant-b` (labels changed, column order swapped, extra interstitial).
Artifact overlay format `artifacts/overlays/<capabilityId>@<version>.<tenant>.json` with
per-step locator candidate overrides, alias tables, added recoverable outcomes, and origin.
`cua replay --tenant tenant-b` merges base + overlay. Canonicalization: recorder rewrites
concrete urls `/member/10042` → `/member/:memberId` in `expect.urlMatches`.
Drift report: `cua drift <artifact> --tenant X` dry-runs locator resolution across steps and
lists which candidates hit, without acting.

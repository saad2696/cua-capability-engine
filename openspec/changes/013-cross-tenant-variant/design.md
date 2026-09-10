# Design
- Overlay schema: `{ tenant, appliesTo: { capabilityId, version }, origin, aliases: { "Member ID": "Account Holder #" }, steps: { "<stepId>": { candidates?: [...], expect? } }, outcomes: [ ... ] }`.
- Merge: aliases applied to role/label/text candidates first (cheap, covers most re-branding); explicit step overrides win; outcomes appended.
- Drift dry-run walks the flow in observe-only mode using the previous step's recorded page state where possible; reports `hit strategy per step` and suggests an overlay skeleton for misses.
- Version drift: if the variant reports a version string in the footer, record it in `provenance.observedAppVersion` and warn when it differs from the base artifact.

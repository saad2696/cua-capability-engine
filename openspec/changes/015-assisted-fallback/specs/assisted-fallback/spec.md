## ADDED Requirements
### Requirement: Bounded, policy-checked assist
When enabled, replay SHALL allow at most one model-assisted element selection per run, only for non-risky steps, only within the allowlist, and SHALL record it as evidence and a patch proposal without altering the artifact.

#### Scenario: Renamed button
- **WHEN** the Search button's locator fails and `--assist` is set
- **THEN** the model selects the button once, replay continues, and `evidence/.../assist.json` plus a patch proposal are written

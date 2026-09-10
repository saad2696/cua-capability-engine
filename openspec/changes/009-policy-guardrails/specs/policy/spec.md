## ADDED Requirements
### Requirement: Configurable allowlist enforced at every boundary
The system SHALL load an explicit allowlist of origins, url patterns, and action types and SHALL block any agent, replay, or network action outside it at decision time, at the surface, and at the network layer.

#### Scenario: Model tries to leave the app
- **WHEN** the model calls `navigate("https://example.com")`
- **THEN** the action is blocked, a `policy_block` event is recorded, and the page url is unchanged

#### Scenario: Hidden redirect
- **WHEN** the target page issues a redirect to a non-allowlisted origin
- **THEN** the request is aborted by route interception and replay fails with `NAVIGATION_BLOCKED`

### Requirement: Risky actions handled conservatively
The system SHALL classify irreversible actions as risky and SHALL require human confirmation during discovery and an approved artifact (or per-run human confirmation) during replay.

#### Scenario: Draft artifact with risky step
- **WHEN** replay of a draft artifact reaches a risky step with `riskyStepsRequire: approvedArtifact`
- **THEN** the run pauses as `escalated` with reason `RISKY_STEP_NEEDS_APPROVAL`

### Requirement: No secrets or raw sensitive data persisted
Artifacts, events, and stored prompts SHALL NOT contain credential values or values of inputs marked `pii` or `secret`.

#### Scenario: Grep the evidence
- **WHEN** a discovery run typed the demo password and member id 10042
- **THEN** neither string appears anywhere under `evidence/` or `artifacts/`

# Change (stretch, last): Bounded LLM-assisted recovery for a single failed step

## Why
The brief lists it as a stretch goal and it is the natural bridge between "replay failed" and
"re-discover". Must stay bounded so replay remains defensibly deterministic by default.

## What changes
`--assist` flag (off by default; never allowed for approved unattended replays without policy
opt-in). On `LOCATOR_NOT_FOUND` or `CHECKPOINT_FAILED` for one step, the engine asks the model
to pick an element for *that step only* from the current observation, subject to the same
policy checks and never for risky steps. Outcome is recorded as `assist` evidence with the
proposed locator; the artifact is not modified, but a patch proposal is written for review.
Limit: one assist per replay.

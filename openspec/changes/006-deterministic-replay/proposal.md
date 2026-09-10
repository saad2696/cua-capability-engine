# Change: Deterministic replay executor with error taxonomy

## Why
This is the production path an AI agent invokes. It must run with no model in the loop, use
stable targeting, verify checkpoints, return declared outputs, and classify every non-happy
state as business outcome, recoverable, or hard failure. The brief calls conflating these
"the most common design mistake".

## What changes
Replay executor, locator resolver integration, wait strategy, per-step and final checkpoints,
detector pipeline, recovery actions, structured `ReplayResult`, `cua replay` command,
`docs/error-taxonomy.md`.

## Out of scope
Any LLM call. Console UI (slice 008).

# Change (stretch): Confidence scoring, approval workflow, multi-run stability

## Why
Turns "versioned and reviewable" into a lifecycle: draft → approved gated on measured
reliability, with a flakiness signal a bank operations team would demand.

## What changes
`cua stability <artifact> --runs N --params ...` replays N times (optionally with a fault
schedule) and writes `stability.json`: pass rate, per-step failure histogram, drift frequency
per locator strategy, p50/p95 duration. Artifact gains `quality: { lastStability, confidence }`.
Approval endpoint refuses when confidence < threshold unless `--force` with reason.

# Roadmap

Build order. Core slices (001–010) are mandatory and each is a vertical slice that leaves the
repo runnable. Stretch slices (011–015) are optional, ordered by impact on the evaluation; stop
after any of them and document the rest as next steps in REPORT.md § Cuts.

| # | Change | Depends on | Brief section | Status |
|---|---|---|---|---|
| 001 | scaffold-monorepo | — | 6 | done |
| 002 | target-app-legacy-cu-core | 001 | 4 | planned |
| 003 | capability-schema | 001 | 3.2, 3.3 | planned |
| 004 | surface-and-perception | 001, 002 | 3.1, 3.7 | planned |
| 005 | discovery-agent-loop | 003, 004 | 3.1, 3.2, 3.5 | planned |
| 006 | deterministic-replay | 003, 004 | 3.3, 3.5 | planned |
| 007 | session-control-and-escalation | 005, 006 | 3.6 | planned |
| 008 | operator-console | 007 | 3.6 | planned |
| 009 | policy-guardrails | 005, 006 | 3.4 | planned |
| 010 | evidence-and-deliverables | all core | 6 | planned |
| 011 | capability-catalog-api (stretch) | 007, 009 | 8 | optional |
| 012 | confidence-approval-stability (stretch) | 006, 008 | 8 | optional |
| 013 | cross-tenant-variant (stretch) | 002, 006 | 3.7, 8 | optional |
| 014 | code-generation (stretch) | 003 | 8 | optional |
| 015 | assisted-fallback (stretch) | 006, 009 | 8 | optional |

## Working agreement
- Pick the next `planned` change, implement its tasks, tick them, run tests, update README,
  commit with the change id, then archive the change (`openspec/changes/archive/`) and merge
  its spec deltas into `openspec/specs/<capability>/spec.md`.
- Never start a stretch slice while a core slice is incomplete.
- Any decision that departs from a design.md gets a one-paragraph ADR in `docs/adr/`.

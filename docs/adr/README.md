# Architecture decision records

The working agreement in `openspec/ROADMAP.md` is that a departure from a slice's `design.md` gets
recorded here rather than argued in a commit message. Each record says what the design called for,
what was built instead, and what made the difference — usually something that only showed up once
the code met the real target app.

| # | Decision | Slice |
|---|---|---|
| [0001](0001-lease-by-wrapping-not-by-contract.md) | Session leases wrap the Surface instead of entering its contract | 007 |
| [0002](0002-graded-risk-classification.md) | Risk has two grades, so a form submit is not an escalation | 009 |
| [0003](0003-visual-drift-by-displacement.md) | Visual drift measures centre displacement, not box overlap | 006 |
| [0004](0004-derived-run-status.md) | Run status is derived, never stored | 007 |
| [0005](0005-text-pseudo-role.md) | A `text` pseudo-role for extraction targets with no accessible name | 006 |
| [0006](0006-accepting-a-dialog-is-its-own-decision.md) | Accepting a dialog is its own decision, and the model needs a way to make it | 010 |

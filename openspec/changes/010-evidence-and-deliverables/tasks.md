# Tasks
- [x] 10.1 Evidence index writer (`cua evidence index`) — regenerates the run table in
      `evidence/README.md` between markers, leaving the hand-written sections alone
- [x] 10.2 Real discovery run G1 with Claude; verify artifact; commit evidence
      (`evidence/discovery-g1-savings-balance/`, produced in slice 005 and still current)
- [x] 10.3 Replay G1: success, not-found, session-expired, unknown-dialog; commit evidence
      (eight directories, produced in slice 006)
- [x] 10.4 Real discovery run G2 with escalation via console; hand back; commit evidence
- [x] 10.5 Replay G2 evidence: the committed path and the blocked path
- [ ] 10.6 README.md complete
- [x] 10.7 REPORT.md complete with seven headings, ~3 pages as the brief asks; the slice-by-slice
      long version moved to docs/design-notes.md rather than discarded
- [x] 10.8 docs/ cross-links; ADRs for major decisions (six, in docs/adr/)
- [ ] 10.9 Final checklist; tag v1.0

Not re-run, because the evidence already exists and is current:
- 10.2 and 10.3 were produced by slices 005 and 006 against the same code paths and the same mock
  app. Re-running them would spend API credits to replace evidence that already says what it needs
  to say. `cua evidence index` lists every directory from the run files themselves, so a stale one
  would show up as a missing or contradictory row rather than as a sentence nobody checked.

What 10.4 turned out to require (see docs/adr/0006 and REPORT § 3):
- G2 could not be completed by the system at all. The application's point of no return is a native
  `confirm()`, and the model had no tool that could answer one. Adding `dismiss_dialog` exposed five
  further defects — the recorder dropped the commit, `pointOfNoReturn` was never set for it, the
  dialog step's precondition could not be satisfied, the dialog matched `UNKNOWN_DIALOG` on the step
  that answers it, and replay treated the dialog-raising click as a surface error.
- A discovery started from the console recorded **no artifact**, which is the one thing the console
  exists to produce. `finishDiscovery()` is now shared by `cua discover` and the server, so both
  produce the same artifact, usage record and `run.json`.

# Design: Evidence and deliverables

## evidence/ layout
```
evidence/
  README.md                      index of runs with one-line description each
  discovery-g1-<runId>/  run.json events.jsonl steps/*.png artifact.json prompt-snapshots/*.md(redacted) usage.json
  discovery-g2-<runId>/  ... + interventions.json (risky confirm escalation)
  replay-g1-success-<runId>/
  replay-g1-not-found-<runId>/       business_outcome MEMBER_NOT_FOUND
  replay-g1-session-expired-<runId>/ recovered
  replay-g1-unknown-dialog-<runId>/  failure bundle
  replay-g2-escalated-<runId>/       human takeover + hand back
  console-demo.gif                   optional
```
`usage.json` records model, tokens, and cost per run.

## README.md sections
Overview · Quick start (prereqs, install, .env) · Run the target app · Demo path (exact commands:
discover G1, replay success, replay not-found, replay with fault, serve + console for G2) ·
Running without live services (FakeProvider, `--provider fake`) · Architecture (diagram) ·
Repository layout · Testing · Safety notes · Docs index.

## REPORT.md (1–3 pages, exact headings)
1. Architecture 2. Artifact schema 3. Determinism & error handling 4. Heterogeneity & multi-tenant
5. Escalation & handoff 6. Safety 7. Cuts. Each section: decision, alternative considered, trade-off.

## Final checklist
- [ ] Paths exact: /README.md /REPORT.md /evidence/
- [ ] Clean clone bootstrap works
- [ ] No secrets in git history (`git log -p | grep -i sk-ant` empty)
- [ ] Every core requirement 3.1–3.7 mapped to code + evidence in REPORT
- [ ] Cuts and next steps listed

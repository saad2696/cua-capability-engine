## ADDED Requirements
### Requirement: Structured evidence per run
Every run SHALL produce a directory with `run.json`, `events.jsonl`, per-step screenshots, and on failure a richer bundle, all redacted.

#### Scenario: Reviewer opens a failed replay
- **WHEN** they open `evidence/replay-g1-unknown-dialog-*/`
- **THEN** they find the step, the dialog text, a full-page screenshot, and the a11y snapshot

### Requirement: Real discovery evidence
The repository SHALL contain evidence of at least one genuine LLM-driven discovery run including model usage.

#### Scenario: Provenance
- **WHEN** a reviewer reads `discovery-g1-*/usage.json` and `artifact.json.provenance`
- **THEN** the model id, token counts, and run id are present and consistent

### Requirement: Deliverables at exact paths
The repository SHALL contain `/README.md` with setup and demo path, `/REPORT.md` with the seven required headings in order, and `/evidence/`.

#### Scenario: Heading check
- **WHEN** REPORT.md headings are listed
- **THEN** they are exactly Architecture, Artifact schema, Determinism & error handling, Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts

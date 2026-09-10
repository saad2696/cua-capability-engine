## ADDED Requirements
### Requirement: Single-command bootstrap
The repository SHALL install, build, and test with `pnpm install && pnpm -r build && pnpm test` on a clean checkout.

#### Scenario: Fresh clone
- **WHEN** a reviewer clones the repo with Node 24 and pnpm installed
- **THEN** the three commands complete without errors and without any API key present

### Requirement: Secrets never committed
The repository SHALL keep all secrets in a gitignored `.env` and SHALL provide `.env.example` listing every variable.

#### Scenario: Key added locally
- **WHEN** a developer copies `.env.example` to `.env` and fills in `ANTHROPIC_API_KEY`
- **THEN** `git status` shows no change to tracked files

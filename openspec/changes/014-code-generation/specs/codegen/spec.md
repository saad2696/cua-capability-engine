## ADDED Requirements
### Requirement: Executable code from artifact
The system SHALL generate a runnable Playwright test from an artifact that passes against the target app.

#### Scenario: Generate and run
- **WHEN** `cua codegen` runs on `member-savings-balance@1`
- **THEN** `npx playwright test tests/generated/member-savings-balance.spec.ts` passes

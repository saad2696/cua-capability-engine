## ADDED Requirements
### Requirement: Live view of the automation browser
The console SHALL display live frames of the session the automation is using and SHALL indicate the current controller visually.

#### Scenario: Controller change
- **WHEN** the operator takes control
- **THEN** the viewport border changes to the human color and input is enabled

### Requirement: Take control and hand back
The console SHALL provide Take control, Hand back (same/next/abort), and Abort actions consistent with the session state machine.

#### Scenario: Hand back next
- **WHEN** the operator chooses Hand back → next
- **THEN** the run resumes and the console shows controller returning to automation

### Requirement: Reviewable artifact rendering
The console SHALL render an artifact's contract, steps with locator candidates and risk, outcomes, and provenance, and SHALL allow approving a draft.

#### Scenario: Approve
- **WHEN** the operator approves `member-savings-balance@1`
- **THEN** the file status becomes `approved` and unattended replay is permitted

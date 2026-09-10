## ADDED Requirements
### Requirement: Detect and route with context
The system SHALL raise an intervention request when stuck, when a risky step needs approval, on unknown state, or on configured failures, carrying goal or capability, step, reason, screenshot, url, and visible elements.

#### Scenario: Risky confirm in discovery
- **WHEN** the agent proposes clicking "Open account" and policy marks it risky
- **THEN** an intervention of kind `risky_step` is created with the screenshot showing the button and suggested actions including `confirm_and_continue`

### Requirement: Human takes control of the live session
The system SHALL stream live frames of the automation browser and forward operator mouse, keyboard, scroll, and dialog inputs to that same page while the operator holds control.

#### Scenario: Operator clicks
- **WHEN** the operator clicks at screenshot coordinates over the Search button
- **THEN** the Search button in the live page is clicked and the next frame shows the result

### Requirement: Human actions are recorded
Every operator action SHALL be recorded as a `human_action` event with a captured locator and redacted value.

#### Scenario: Operator types a member id
- **WHEN** the operator types into the Member ID field
- **THEN** evidence records `human_action { action: type, locator: {role textbox "Member ID"...}, value: "[redacted:pii]" }`

### Requirement: Hand back with intent
The operator SHALL hand back with `same`, `next`, or `abort`, and the run SHALL continue accordingly with evidence continuous across the handoff.

#### Scenario: Skip completed step
- **WHEN** the operator performed the step manually and hands back with `next`
- **THEN** replay verifies the current page state and continues from the following step

### Requirement: Sandbox scenario controls
The engine SHALL expose demo controls that act on the live automation session: inject any declared fault (not found, validation, permission denied, session expired, unexpected dialog, slow, server error) as one-shot or sticky, force a human intervention (pause now), and resume. These SHALL affect only the automation browser's session, never the operator's own browser.

#### Scenario: Corner case on demand
- **WHEN** an operator injects `unexpected_dialog` during a replay
- **THEN** the next step observes the dialog, replay classifies it (recoverable if declared, else `UNKNOWN_DIALOG`), and the console shows the classification

#### Scenario: Encourage intervention, then resume
- **WHEN** an operator clicks "Force human intervention" during discovery
- **THEN** the run pauses with reason `MANUAL_PAUSE`, the operator can take control, perform steps, hand back, and the run resumes on the same session

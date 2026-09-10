## ADDED Requirements
### Requirement: Single explicit controller
A session SHALL have exactly one controller among `none`, `agent`, `replay`, `human` at all times, and only the current controller SHALL be able to act on the surface.

#### Scenario: Automation acts during human control
- **WHEN** the replay executor attempts an action while controller is `human`
- **THEN** the action is rejected, a `CONTROL_VIOLATION` event is logged, and the page is unchanged

### Requirement: Pause and resume on the same session
Automation SHALL be able to pause before any step, cede control, and later resume on the same browser context, cookies, and page.

#### Scenario: Resume after human login
- **WHEN** a replay pauses at `SESSION_EXPIRED`, a human logs in, and hands back with `resumeAt: same`
- **THEN** the replay continues from the paused step without relaunching the browser and completes

### Requirement: Intervention timeout
A paused session SHALL abort with `INTERVENTION_TIMEOUT` if no human claims it within the configured window.

#### Scenario: Nobody available
- **WHEN** an intervention stays open past the timeout
- **THEN** the run ends `escalated` with reason `INTERVENTION_TIMEOUT` and the browser is closed

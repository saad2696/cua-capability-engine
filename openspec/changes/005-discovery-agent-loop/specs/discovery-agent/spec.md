## ADDED Requirements
### Requirement: Goal-driven observe-decide-act loop
The system SHALL accept a natural-language goal, a target URL, and named parameters, and SHALL run an LLM-driven loop against the live surface until `done`, `give_up`, max steps, timeout, policy block, or loop detection.

#### Scenario: Goal completed
- **WHEN** `cua discover` is run for goal G1 with a working provider
- **THEN** the run ends with `done`, outputs include `savingsBalance`, and a validated artifact is written

#### Scenario: Dead end
- **WHEN** the model returns the same action three times in a row
- **THEN** the loop stops and raises an escalation with reason `loop_detected`

### Requirement: Provider seam
The loop SHALL depend only on `LlmProvider`, and the test suite SHALL run fully with `FakeProvider` and no network.

#### Scenario: CI without keys
- **WHEN** tests run with no `ANTHROPIC_API_KEY`
- **THEN** all discovery tests pass

### Requirement: Recorder decouples artifact from transcript
The recorder SHALL produce the artifact from the action trace and observations only; the model transcript SHALL be stored in evidence, not in the artifact.

#### Scenario: Artifact review
- **WHEN** a reviewer opens the artifact
- **THEN** it contains steps, locators, contract, and outcomes but no model messages

### Requirement: Token hygiene
Each model turn SHALL include at most one downscaled screenshot, a capped element list, and compacted history.

#### Scenario: Long run
- **WHEN** a run reaches step 20
- **THEN** the prompt contains verbatim observations for at most the last 3 steps

### Requirement: Clean artifact from a messy run
The recorder SHALL prune detours and no-op actions from the trajectory and SHALL verify the pruned artifact by deterministic replay before saving it as draft.

#### Scenario: Wrong tab first
- **WHEN** the model opens "Loans" by mistake, returns, and completes the goal
- **THEN** the saved artifact contains no Loans steps and the verification replay succeeded

### Requirement: Encountered states become declared outcomes
Any error page, dialog, or validation message seen during discovery SHALL be added to the artifact's outcome catalog with a detector.

#### Scenario: Not-found seen during discovery
- **WHEN** the model first searched a wrong id and saw "No member found"
- **THEN** the artifact declares `MEMBER_NOT_FOUND` with a `textMatches` detector

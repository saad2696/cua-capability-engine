## ADDED Requirements
### Requirement: Typed, versioned capability artifact
The system SHALL represent a recorded flow as a JSON artifact that validates against a published schema and carries `schemaVersion`, `capability.version`, and `capability.status`.

#### Scenario: Validation
- **WHEN** `cua artifact validate` is run on a saved artifact
- **THEN** it reports pass or lists every violation with a JSON path

### Requirement: Clear contract for callers
The artifact SHALL declare typed `inputs`, typed `outputs` with the step each output is extracted from, and a `checkpoint` success condition.

#### Scenario: Agent reads the contract
- **WHEN** an agent loads `member-savings-balance@1.json`
- **THEN** it can determine without executing that `memberId: string` is required and `savingsBalance: money` is returned

### Requirement: Multi-candidate locators with rationale
Each step target SHALL contain an ordered list of locator candidates using at least two distinct strategies and a human-readable rationale.

#### Scenario: Review
- **WHEN** a reviewer opens a step
- **THEN** they see why the primary strategy was chosen and what the fallbacks are

### Requirement: Declared outcome catalog
The artifact SHALL list expected non-success outcomes, each tagged `business`, `recoverable`, or `failure`, with its detector.

#### Scenario: Not-found is not a crash
- **WHEN** the artifact for member lookup is reviewed
- **THEN** `MEMBER_NOT_FOUND` appears with kind `business`

### Requirement: No sensitive literals
The artifact SHALL NOT contain credential values or values of inputs marked `pii` or `secret`; such values SHALL be `{ param }` or `{ secret }` references.

#### Scenario: Recorder output
- **WHEN** a discovery run typed a member id supplied as a parameter
- **THEN** the saved step has `value: { "param": "memberId" }`, not the literal id

### Requirement: Structured replay result
Replay SHALL return exactly one of `success`, `business_outcome`, `failure`, or `escalated`, each with the fields needed to act on or debug it.

#### Scenario: Failure detail
- **WHEN** a replay fails at a step
- **THEN** the result includes the step id, what was expected, what was observed, and the evidence directory

### Requirement: Screen-state preconditions
Each step SHALL declare a screen signature (url pattern, landmarks, negatives) that replay verifies before acting.

#### Scenario: Wrong screen detected early
- **WHEN** replay reaches step 4 but the page lacks the recorded landmarks
- **THEN** the result is `failure` with code `WRONG_SCREEN`, listing expected and observed landmarks

### Requirement: Side-effect awareness
Steps SHALL be markable as `pointOfNoReturn`, and any result produced after such a step succeeded SHALL carry `sideEffects: "possible" | "committed" | "none"`.

#### Scenario: Failure after commit
- **WHEN** the confirm step succeeds but the confirmation page fails its checkpoint
- **THEN** the result is `failure` with `sideEffects: "possible"` so the caller does not retry blindly

### Requirement: Robust extraction
Outputs SHALL declare extraction candidates with fallbacks, a parser, and validation rules.

#### Scenario: Layout change moves the balance
- **WHEN** the recorded locator for the balance cell fails but the label-relative strategy finds it
- **THEN** the output is extracted, parsed, validated, and a `drift` event is recorded

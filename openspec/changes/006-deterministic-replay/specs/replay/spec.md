## ADDED Requirements
### Requirement: Replay without a model
Replay SHALL execute a saved artifact with supplied parameters using only the artifact, the surface, and policy; it SHALL make no LLM calls.

#### Scenario: Provider absent
- **WHEN** `cua replay` runs with no `ANTHROPIC_API_KEY`
- **THEN** it completes and the evidence contains no `decide` events

### Requirement: Pre-flight validation
Replay SHALL validate the artifact, parameters, secrets, policy, and approval status before opening a browser and SHALL return a `failure` with a specific code if any check fails.

#### Scenario: Bad member id format
- **WHEN** replay is invoked with `memberId=abc` against a pattern `^[0-9]{5}$`
- **THEN** the result is `failure` with code `INVALID_INPUT` and no browser is launched

### Requirement: Stable targeting with drift signal
Replay SHALL resolve each target by trying locator candidates in order and SHALL emit a `drift` event whenever a non-primary candidate is used.

#### Scenario: Label renamed
- **WHEN** the target's textbox accessible name changed but the css path still matches
- **THEN** the step succeeds and evidence contains a `drift` event naming the step and matched strategy

### Requirement: Per-step and final checkpoints
Replay SHALL verify each step's `expect` and the artifact `checkpoint`, failing with expected-vs-observed detail when a check does not hold within the step timeout.

#### Scenario: Click did nothing
- **WHEN** the Search button click does not change the url within the timeout
- **THEN** the result is `failure` with code `CHECKPOINT_FAILED`, `expected: urlMatches /member/`, and the observed url

### Requirement: Business outcomes are results, not errors
Replay SHALL return `business_outcome` with the declared code when a `kind: business` detector matches, with exit code 0.

#### Scenario: Unknown member
- **WHEN** replay runs with `memberId=99999`
- **THEN** the result is `business_outcome` with code `MEMBER_NOT_FOUND`

#### Scenario: Validation error on form
- **WHEN** the sub-account form rejects input with an inline error
- **THEN** the result is `business_outcome` with code `VALIDATION_ERROR` and the error text as `message`

### Requirement: Recoverable conditions are handled and logged
Replay SHALL apply the declared recovery for `kind: recoverable` outcomes within fixed limits, record each recovery in evidence, and continue.

#### Scenario: Session expired mid-flow
- **WHEN** the app redirects to `/login` before the detail step
- **THEN** replay runs the login prelude once, re-runs the step, and returns `success` with a `recover` event

#### Scenario: Transient slowness
- **WHEN** a page takes longer than the slow threshold but loads within the extended wait
- **THEN** replay continues and records `SLOW_LOAD`

#### Scenario: Recovery loop
- **WHEN** the same recoverable outcome triggers twice on one step
- **THEN** replay stops with `failure` code `RECOVERY_LOOP`

### Requirement: Hard failures are debuggable
On any hard failure replay SHALL save a full-page screenshot, an accessibility snapshot, and redacted page text, and SHALL return step id, expected, observed, and evidence directory.

#### Scenario: Unexpected dialog
- **WHEN** an undeclared alert appears
- **THEN** the result is `failure` code `UNKNOWN_DIALOG` with the dialog message as `observed` and the failure bundle on disk

### Requirement: Typed outputs
Replay SHALL return outputs parsed to their declared types.

#### Scenario: Money output
- **WHEN** the savings balance cell reads `$1,234.56`
- **THEN** `outputs.savingsBalance` is `{ amount: 1234.56, currency: "USD" }`

### Requirement: Plan before run
Replay SHALL offer a plan mode that performs all pre-flight checks and prints the step plan without launching a browser.

#### Scenario: Reviewer inspects
- **WHEN** `cua replay --plan` runs on an approved artifact
- **THEN** it lists each step's intent, primary locator, precondition, risk, and point-of-no-return flag

### Requirement: Retry only what is safe to retry
Replay SHALL retry only steps marked `retryable` and SHALL attempt non-retryable steps exactly once.

#### Scenario: Confirm click times out
- **WHEN** the non-retryable confirm step's checkpoint fails
- **THEN** the step is not re-clicked and the result reports `sideEffects: "possible"`

### Requirement: Resume on an existing session
Replay SHALL be able to continue from a given step on an existing paused session when that step's precondition holds.

#### Scenario: After hand back
- **WHEN** a human completed step 5 manually and the engine resumes from step 6
- **THEN** replay verifies step 6's precondition and continues without relaunching the browser

### Requirement: Human-readable failure narrative
On failure replay SHALL write a `failure.md` narrative alongside the machine-readable result and a Playwright trace.

#### Scenario: Debugging
- **WHEN** a developer opens the failure directory
- **THEN** `failure.md` states the step, expectation, observation, last events, and a suggested next action, and `trace.zip` opens in the Playwright trace viewer

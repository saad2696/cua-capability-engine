# Error taxonomy

A replay run ends in exactly one of four states. The distinction is the whole point of the system:
an automation that reports "it broke" for both *"this member does not exist"* and *"the Search button
moved"* forces a human to look at every run. Separating them is what makes unattended replay viable.

| Status | Exit code | Meaning | Who acts |
| --- | --- | --- | --- |
| `success` | 0 | The flow completed and every required output was extracted. | Nobody |
| `business_outcome` | 0 | The application gave a legitimate answer that is not the happy path. | The caller, in its own logic |
| `failure` | 2 | The automation could not proceed. Something about the app or the artifact is wrong. | An engineer |
| `escalated` | 3 | A human was handed the live session. | An operator |

`business_outcome` exiting 0 is deliberate. "No member found" is data, not a defect, and a caller that
treats it as an error will retry forever against an app that will never change its mind.

## Business outcomes

Declared per capability in the artifact's `outcomes` catalog, each with a detector and a stable code.
They end the run immediately and carry any outputs extracted so far.

| Code | Detected by | Meaning |
| --- | --- | --- |
| `MEMBER_NOT_FOUND` | text "No member found" | The member ID is not in the core. |
| `INVALID_MEMBER_ID` | text "must be exactly five digits" | The app rejected the ID's format. |
| `VALIDATION_ERROR` | text matching a `VAL-nnnn` code or "is required" | A submitted form was rejected. |
| `PERMISSION_DENIED` | text "not authorized" | The operator account lacks the entitlement. |

These are artifact data, not engine constants: a new tenant adds its own codes without a code change.

## Recoverable conditions

Also declared in the catalog, but with a bounded `recover` action and a `maxRecoveries` budget. The
run continues if the recovery works. Every attempt is written to the evidence log and surfaces in
`result.recoveries`, so a capability that silently recovers on most runs is still visible as drift.

| Code | Recovery | Budget | Notes |
| --- | --- | --- | --- |
| `SESSION_EXPIRED` | `prelude:login` | 1 | Re-runs the login prelude, then restarts the affected sequence. |
| `MAINTENANCE_NOTICE` | `dismissDialog` | 2 | A declared, benign alert. Anything undeclared is `UNKNOWN_DIALOG`. |
| `SERVER_ERROR` | `reload` | 2 | The app's own 500 page. Retried, not reported. |

Two rules keep recovery from becoming a loop or a hazard:

**A recovery cannot be triggered by the screen it exists to reach.** The sign-in screen matches
`SESSION_EXPIRED`, and it is also where the login prelude legitimately starts. So while a prelude is
running, its own recovery outcome is inert *for precondition checks*. It stays live for
postconditions: seeing the sign-in screen *after* submitting credentials means the sign-in did not
stick, which is exactly the condition the recovery is for. Without this split the login prelude
restarts itself on its own first step, forever.

**A flow cannot be restarted after it has committed something.** Re-running the login prelude is
free. Re-running a flow that has already clicked "Open Account" is not. When a recoverable condition
appears after a point of no return, the run stops with `UNSAFE_RESTART` rather than replaying the
committed action.

## Hard failures

A closed enum, so callers can switch on it exhaustively. Each one writes a failure bundle to the
evidence directory: viewport screenshot, full-page screenshot, accessibility snapshot, visible text,
and a markdown narrative with a suggested next action.

### Pre-flight — checked before a browser opens

| Code | Cause |
| --- | --- |
| `INVALID_ARTIFACT` | The artifact does not satisfy the schema or its internal consistency rules. |
| `INVALID_INPUT` | A parameter is missing, unknown, or fails its declared pattern. |
| `MISSING_SECRET` | A secret the artifact requires is not in the environment. |
| `ARTIFACT_NOT_APPROVED` | Unattended replay of a `draft` artifact, without `--allow-draft`. |
| `POLICY_VIOLATION` | The artifact's origins or actions exceed the global policy. |
| `RUN_IN_PROGRESS` | The same capability is already running. Prevents double submission. |

Earlier still, before any of the above: a `policy.yaml` that does not parse or does not satisfy the
schema stops the run with the issues listed and **exit 2**, and the server answers **400** with the
same issues rather than 500. A guardrail that cannot be read is a guardrail failure, and the loader
deliberately does not fall back to the built-in defaults — silently widening what the engine may
touch is the one response worse than refusing to start. `cua doctor` reports the same issues in the
same words, and resolves the file the same way a run does, so the two cannot disagree about which
policy is in force.

Catching these before launching Chromium means a bad call costs milliseconds, not a browser session,
and `stepsRun: 0` proves nothing touched the target app.

### Runtime

| Code | Cause | Suggested action |
| --- | --- | --- |
| `WRONG_SCREEN` | A step's screen signature did not hold. | Compare the failure screenshot with the recorded step; look for an interstitial. |
| `LOCATOR_NOT_FOUND` | No locator candidate matched. The failure lists what *was* visible. | Re-record the step, or add a tenant overlay. |
| `AMBIGUOUS_LOCATOR` | A candidate matched several elements and proximity could not break the tie. | Tighten the candidate. |
| `CHECKPOINT_FAILED` | The action ran but the expected state did not appear. | Look for an error banner the outcome catalog does not know yet. |
| `FINAL_CHECKPOINT_FAILED` | The end-of-run assertion failed. | As above, at the flow level. |
| `EXTRACTION_FAILED` | No extraction candidate produced a parseable value. | Check the table layout; add a candidate. |
| `UNKNOWN_DIALOG` | An undeclared dialog blocked the run. | If benign, declare it as a recoverable outcome. |
| `RECOVERY_LOOP` | A recovery exhausted its budget; the condition is persistent. | Escalate. The app is in a state the artifact does not model. |
| `UNSAFE_RESTART` | A recoverable condition appeared after a point of no return. | A human must check whether the committed action landed. |
| `STEP_TIMEOUT` / `RUN_TIMEOUT` | A step or the run exceeded its budget. | Check for a hung request. |
| `NAVIGATION_BLOCKED` | The flow tried to leave the allowlisted origins. | Either the app changed or the artifact is wrong. |
| `PAGE_SWITCH_BLOCKED` | A popup outside the allowlist was opened and closed. | As above. |
| `SESSION_LOST` | Authentication was lost and could not be re-established. | Check the credentials. |
| `CONTROL_VIOLATION` | The engine acted while a human held the session lease. | An engine bug. Report it. |
| `CANCELLED` | The caller or the session controller stopped the run. | None. |
| `SURFACE_ERROR` | The browser layer itself failed. | Check the trace. |

## Escalation

A run escalates when a human needs the *live session*, not a bug report. The reason is typed:

| Reason | Raised when |
| --- | --- |
| `RISKY_STEP_NEEDS_APPROVAL` | A step marked risky is about to run on an unapproved artifact. |
| `OUTCOME_ESCALATE` | A declared failure outcome with `escalate: true` matched. |
| `REPLAY_FAILURE` | A hard failure, when the run was started with `--escalate-on-failure`. |
| `AGENT_GAVE_UP` / `LOOP_DETECTED` / `MAX_STEPS_REACHED` / `UNKNOWN_STATE` | Discovery-mode only. |
| `INTERVENTION_TIMEOUT` | Nobody took the escalation in time. |

The operator answers with `same`, `next`, or `abort`: re-run the step after fixing the screen, skip
it because they performed it by hand, or stop. The browser is never restarted, so cookies, session,
and half-filled forms survive the handover.

## Side effects

Every result, of every status, carries `sideEffects`. It is the field a caller must read before
retrying anything.

| Value | Meaning |
| --- | --- |
| `none` | No step marked `pointOfNoReturn` ran. Safe to retry. |
| `possible` | Such a step ran but its confirmation was never observed. **Do not retry. A human must check.** |
| `committed` | The step ran and its confirmation was observed. Retrying would duplicate it. |

Read-only capabilities like G1 always report `none`, which is what makes them safe to run unattended
at any rate. `possible` is the dangerous state and the reason it exists as a separate value: the
automation genuinely does not know, and saying so is more useful than guessing either way.

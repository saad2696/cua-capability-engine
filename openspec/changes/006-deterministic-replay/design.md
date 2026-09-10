# Design: Replay

## Inputs
`replay(artifact, params, options)`; options: `timeoutMs`, `stepTimeoutMs`, `headless`,
`faultInjection?` (test only), `approvalMode`.

## Pre-flight (before opening the browser)
1. Validate artifact against schema; reject `status: deprecated`.
2. Validate params against `inputs`: required present, pattern matches, unknown params rejected.
   Failure → `failure` with code `INVALID_INPUT` (no browser opened).
3. Resolve `{ secret }` references from environment; missing → `failure` `MISSING_SECRET`.
4. Policy: artifact `policy.allowedOrigins` must be a subset of global policy; else `POLICY_VIOLATION`.
5. Approval gate: if `replay.requireApprovedArtifact` and status is `draft` → `failure` `ARTIFACT_NOT_APPROVED` unless `--allow-draft`.

## Step execution
```
run preconditions (e.g. prelude:login) if not satisfied
for step in steps:
  waitFor(step.wait ?? default)                       # networkidle-ish + settle 150ms
  detect(preStep)                                     # dialogs, error pages, session loss
  el = resolve(step.target)                           # ordered candidates
     none → failure LOCATOR_NOT_FOUND (expected: primary candidate; observed: page title/url + top 10 elements)
     matchedStrategy != primary → emit drift event
  act(step, el, value(step, params, secrets))
  verify(step.expect) with retry until stepTimeoutMs → failure CHECKPOINT_FAILED
  detect(postStep)
  if step.action == extract: outputs[name] = parse(step.outputType, text)
verify(artifact.checkpoint) → failure FINAL_CHECKPOINT_FAILED
return success
```

## Detector pipeline
Runs after every navigation/action. Order matters; first match wins:
1. Native dialog open → match against `outcomes` with `dialogOpen`; declared recoverable → dismiss
   per outcome; undeclared → `failure UNKNOWN_DIALOG` (escalate if configured).
2. URL-based detectors (`/login` ⇒ SESSION_EXPIRED; 403 page ⇒ PERMISSION_DENIED).
3. Text-based detectors on visible text (No member found ⇒ MEMBER_NOT_FOUND; validation
   message ⇒ VALIDATION_ERROR with the message captured as `observed`).
4. HTTP status of the main frame response 5xx ⇒ SERVER_ERROR (recoverable with 2 retries, then failure).
5. Page still loading past `slowThresholdMs` ⇒ SLOW_LOAD recoverable: extend wait up to 3x.

## Recovery actions
| action | behavior | limits |
|---|---|---|
| `prelude:login` | run prelude steps then re-run the current step | once per replay |
| `dismissDialog` | accept/dismiss as declared, then continue | per declared outcome |
| `retry` | wait with backoff (500ms, 1500ms, 4000ms), re-run current step | 3 attempts |
| `reload` | reload page, re-verify previous step's expect | once per step |

Every recovery is an evidence event `recover` with before/after screenshots. If the same
recoverable outcome triggers twice on the same step → escalate to `failure RECOVERY_LOOP`.

## Business outcomes
Declared `kind: business` detectors stop the replay and return `business_outcome` with the
code, message, and any outputs already extracted. This is a normal exit, not an error, and the
process exit code is 0.

## Determinism rules
- No randomness, no model, no timing-dependent decisions except bounded waits.
- Waits are condition-based (element visible, url changed, network idle) never fixed sleeps,
  except the 150ms settle after action.
- Typing uses `fill` then verifies value; falls back to `pressSequentially` if the field rejects fill.
- Clicks require the element to be visible, enabled, and stable; scroll into view first.
- Frames re-resolved on every step because framesets reload frames.
- Every replay of the same artifact with the same params on the same target state produces the
  same step sequence and result; the stability slice (012) measures this.

## Result and evidence
`ReplayResult` per schema. Evidence dir `evidence/replay-<runId>/` with `events.jsonl`,
`steps/NN.png`, `result.json`; on failure also `failure-fullpage.png`, `failure-a11y.json`,
`failure-html.txt` (redacted). Exit codes: success 0, business_outcome 0, failure 2, escalated 3.

## Error taxonomy (docs/error-taxonomy.md)
| code | kind | default handling |
|---|---|---|
| MEMBER_NOT_FOUND | business | return to caller |
| VALIDATION_ERROR | business | return with message |
| PERMISSION_DENIED | business | return; flag for operator review |
| SESSION_EXPIRED | recoverable | prelude:login once |
| KNOWN_INTERSTITIAL | recoverable | dismissDialog |
| SLOW_LOAD | recoverable | extend wait ×3 |
| SERVER_ERROR | recoverable→failure | retry ×2 then fail |
| INVALID_INPUT, MISSING_SECRET, ARTIFACT_NOT_APPROVED, POLICY_VIOLATION | failure (pre-flight) | stop before browser |
| LOCATOR_NOT_FOUND, CHECKPOINT_FAILED, FINAL_CHECKPOINT_FAILED, UNKNOWN_DIALOG, RECOVERY_LOOP, STEP_TIMEOUT, RUN_TIMEOUT, NAVIGATION_BLOCKED | failure | stop, evidence, optional escalate |
| RISKY_STEP_NEEDS_APPROVAL | escalated | pause for human |

## Replay robustness additions

### Plan mode
`cua replay --plan` performs pre-flight and prints the step plan (intent, target primary
candidate, precondition, risk, point of no return) without opening a browser. Used by callers
and reviewers; also the first thing the console shows before a run.

### Precondition check before every step
Verify `step.precondition` signature (≥2 landmarks, url pattern, negatives). Miss → try one
`settle + re-observe` cycle (handles late renders), then `WRONG_SCREEN`. If a declared
recoverable outcome matches instead (e.g. login page), run its recovery and re-check.

### Retry matrix
| step.retryable | failure kind | behavior |
|---|---|---|
| true | locator/transient/slow | retry per backoff, then fail |
| false | any | exactly one attempt; fail immediately; if step is `pointOfNoReturn` result has `sideEffects: possible` |
| optional=true | precondition not met | skip with `skipped_optional` event |

### Side-effect tracking
`result.sideEffects` = `none` until a `pointOfNoReturn` step is attempted; `possible` once
attempted and outcome unknown; `committed` once its `expect` verified. Business outcomes and
failures carry it. `success` implies `committed` or `none`.

### Resume from step
`replay --resume-from <stepId> --session <id>` continues an existing paused session (used after
human hand back) instead of starting over. Requires precondition of that step to hold.

### Popups, new tabs, frames
New page in the context: if same allowed origin, adopt it as the active page and log `page_switch`;
otherwise close it and log `policy_block`. Framesets: frames re-resolved every step by recorded
frame path with name→index fallback. Detached element between resolve and act → re-resolve once.

### Input robustness
`type` uses fill → verify value → fallback to pressSequentially → verify; masks value in logs.
`select` matches by label, then value. `click` waits for stable bbox (two consecutive equal
measurements), scrolls into view, uses a11y click first then coordinate click as fallback.
Checkbox/radio: assert desired state rather than toggle blindly.

### Text and locale normalization for detectors
Collapse whitespace, case-insensitive by default, NFC normalize, strip currency/thousands
separators for numeric comparisons; detectors can set `exact: true`.

### Visual drift signal
Per step, compare the current screenshot to the discovery reference screenshot (SSIM over the
downscaled image, ignoring the recorded bbox of dynamic regions such as dates). Below threshold
emits a soft `visual_drift` event; never fails a run alone. Feeds the confidence score.

### Richer failure evidence
On failure: full-page PNG, a11y snapshot JSON, redacted text, the Playwright trace zip for the
run (`--trace on` by default in replay), and `failure.md` with a human-readable narrative:
what step, what was expected, what was observed, last 5 events, suggested next action.

### Budgets and cancellation
Per-step and run budgets; cancellation token honored between steps and inside waits; on cancel
the result is `failure CANCELLED` with side-effect state. Browser always closed in `finally`.

### Concurrency
Replay executor is single-session by design. A run lock per artifact+params key prevents two
identical invocations racing on the same member (returns `failure RUN_IN_PROGRESS`).

## Updated taxonomy additions
`WRONG_SCREEN`, `EXTRACTION_FAILED`, `CANCELLED`, `RUN_IN_PROGRESS`, `PAGE_SWITCH_BLOCKED`,
`skipped_optional` (event), `visual_drift` (event), `page_switch` (event).

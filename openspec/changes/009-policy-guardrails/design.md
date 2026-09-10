# Design: Policy

## policy.yaml
```yaml
version: 1
allowedOrigins: ["http://localhost:4100"]
blockedUrlPatterns: ["/admin", "/__faults"]          # even inside allowed origins
allowedActions: [click, type, select, press, navigate, extract, assert]
maxSteps: 40
runTimeoutMs: 300000
risk:
  irreversibleButtonText: ["Confirm", "Submit", "Open account", "Transfer", "Delete", "Close account", "Approve"]
  irreversibleUrlPatterns: ["/confirm", "/submit"]
  formSubmitIsRisky: true
  keyboardEnterOnFormIsRisky: true
discovery:
  onRisky: escalate            # escalate | block
replay:
  requireApprovedArtifact: true
  riskyStepsRequire: approvedArtifact   # approvedArtifact | humanConfirm | block
  escalateOnFailure: false
redaction:
  sensitiveInputPattern: ["password", "ssn", "social", "pin", "secret", "token"]
  paramSensitivityDefault: pii
  maskEvidenceScreenshots: false   # see limits
  logTypedValues: false
```

## Enforcement points (defense in depth)
1. **Decision time** (discovery): model tool call checked before acting. Out of allowlist →
   `policy_block` event, model told why, counted toward dead-end.
2. **Surface boundary**: `Surface.act` and `navigate` check origin/patterns again, so replay and
   human forwarding (logged as override) pass through the same gate.
3. **Network**: Playwright route interception blocks requests to non-allowlisted origins
   (except same-origin assets), so a hidden redirect cannot leak the session elsewhere.
4. **Pre-flight** (replay): artifact policy must be a subset of global.

## Risk classification
An action is `risky` if any: target text matches irreversible list (case-insensitive, trimmed);
target is a submit button/`type=submit`; Enter pressed while focus is in a form; url pattern
matches; the model itself flagged it. Risky actions: discovery → escalate (human confirms in
console, then the action executes under the agent controller with `approvedBy` recorded);
replay → allowed only when artifact `approved` (or humanConfirm mode pauses each time).

## Redaction
- Inputs: `sensitivity: secret` → never logged, never in screenshots' element list values;
  `pii` → replaced by `[redacted:pii]` in events, `{ param }` in artifact.
- Typed text into fields whose name matches `sensitiveInputPattern` is masked even if unnamed.
- Model prompt: values are sent to the model as needed (it must type them) but the prompt
  stored in evidence is the redacted rendering.
- Screenshots: stored locally; contain synthetic data only. Documented limit: real deployment
  would blur regions of sensitive inputs using their bboxes (we record bboxes, so this is a
  small follow-up) and store evidence in an encrypted bucket with retention.
- Secrets resolved from env at act time; `.env` gitignored; `cua doctor` warns if `.env` is tracked.

## Tests
Allowlist: navigate to other origin blocked at decision and at surface; blocked pattern inside
origin blocked. Risk: "Open account" is risky; "Search" is not; Enter in form risky. Redaction:
event log never contains the password or the member id literal; artifact never contains them;
sensitive field typed value masked.

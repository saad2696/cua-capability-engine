# Design: Session control and escalation

## Controller state machine
```
controller ∈ { none, agent, replay, human }
state      ∈ { idle, running, paused, human_control, resuming, completed, aborted }

running(agent|replay) --stuck/risky/failure(escalate)--> paused        [controller=none, InterventionRequest open]
paused --operator takes control--> human_control                      [controller=human, lease issued]
human_control --hand back {resumeAt}--> resuming                       [controller=none]
resuming --engine re-observes--> running                               [controller=agent|replay]
human_control --abort--> aborted
paused --timeout (configurable, default 15 min)--> aborted             [result escalated, reason INTERVENTION_TIMEOUT]
```
Invariants: exactly one controller or none; every `act` carries a lease token; the surface
rejects acts whose lease is not current (`CONTROL_VIOLATION`, logged). Engine automation loops
check `session.shouldPause()` before every step.

## InterventionRequest
```ts
{ id, runId, kind: "stuck|risky_step|unknown_state|replay_failure|agent_gave_up|loop_detected",
  capabilityId?, goal?, stepId?, stepIndex, reason, screenshotPath, url, elements: ElementSummary[],
  suggestedActions: ["confirm_and_continue","skip_step","retry_step","abort"],
  createdAt, status: "open|claimed|resolved|expired", claimedBy?, resolution? }
```
Context is enough for an operator to act without reading logs.

## Triggers
Discovery: `give_up`, loop detected, policy block on risky action (`onRisky: escalate`),
max steps reached with progress, unknown dialog.
Replay: outcome with `escalate: true`, RISKY_STEP_NEEDS_APPROVAL when `riskyStepsRequire: humanConfirm`,
any hard failure when `--escalate-on-failure`.

## Taking control (same session)
- Live frames: engine streams JPEG screenshots over WebSocket at ~4 fps while `human_control`
  (2 fps otherwise, 0 when idle). Frames carry a `frameSeq` and the current url.
- Input: WebSocket messages `{ type: "mouse", op: "click|move|down|up", x, y }`,
  `{ type: "key", op: "press|type", key|text }`, `{ type: "scroll", dx, dy }`, `{ type: "dialog", accept, text? }`.
  Coordinates are in screenshot space and mapped to viewport. Only accepted with a valid lease.
- Human action capture: for every click, the engine hit-tests the a11y element at (x,y), captures a
  `Locator` exactly as for agent actions, and writes a `human_action` event
  `{ action, locator, value(redacted), screenshotBefore, screenshotAfter }`. Typed text into
  fields marked sensitive is redacted in evidence.
- Optional "record as steps": on hand back the operator can mark the human actions as a patch
  proposal; stored as `evidence/.../human-patch.json` (not auto-applied to the artifact).

## Handing back
`resumeAt: "same" | "next" | "abort"` plus optional note. Engine re-observes the page, runs
detectors, and then either re-verifies the current step's `expect` (same) or advances (next).
For discovery, the model receives a system note "a human operator performed steps; current
state follows" and the recorder marks the boundary. Evidence dir is continuous; `run.json`
records `handoffs: [{ interventionId, from, to, durationMs, actions }]`.

## Server API (engine/server)
```
GET  /runs, GET /runs/:id, GET /runs/:id/events (SSE)
POST /discover, POST /replay
GET  /interventions, POST /interventions/:id/claim, POST /interventions/:id/resolve {resumeAt, note}
GET  /artifacts, GET /artifacts/:id, POST /artifacts/:id/approve
WS   /sessions/:id/live   frames out, inputs in
```
Bind to localhost only.

## Edge cases
- Operator disconnects during human_control → keep lease 60s, then revert to `paused`.
- Human navigates outside allowlist → allowed (human is trusted) but logged as `policy_override`.
- Human closes the page → run aborted with `SESSION_LOST`.
- Two operators claim → second gets 409.
- Engine crash while paused → on restart interventions are reloaded from disk as `expired`.
- Dialog open when human takes control → dialog forwarded to console; human decides.

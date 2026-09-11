# Tasks
- [x] 7.1 `Session` class: state machine, controller, lease tokens, `shouldPause()`, timeouts
- [x] 7.2 Surface `act` enforces lease; `CONTROL_VIOLATION` event
- [x] 7.3 `InterventionRequest` store (in-memory + `evidence/<run>/interventions.json`)
- [x] 7.4 Escalation triggers wired into discovery loop and replay executor
- [x] 7.5 Frame streamer (fps by state) and input forwarder with coordinate mapping
- [x] 7.6 Human action capture with locator hit-test and redaction
- [x] 7.7 Hand back: resumeAt semantics for replay (same/next/abort, resolved in the live session)
- [x] 7.8 HTTP + WS server (Fastify or Express + ws), localhost only, SSE for events
- [x] 7.9 `cua serve` and headless curl demo: pause a replay, take control via WS client script, hand back
- [x] 7.10 Tests: state machine transitions; lease rejection; intervention timeout; disconnect grace; resume same/next/abort
- [x] 7.11 Scenario API for demos: `POST /runs/:id/scenario {fault}` sets the target app's fault cookie inside the automation browser context (one-shot or sticky) so the next step of the live run hits it; `POST /runs/:id/pause` forces an intervention (reason MANUAL_PAUSE)

Deferred with a reason:
- 7.7 (discovery half) resuming a *discovery* run after a human acted, with a system note to the
  model and a recorder boundary marker. The discovery loop currently ends the run when it escalates,
  so this needs a real change to the loop's control flow rather than a wiring change. What is wired
  today is the case that matters for the demo: a risky action during discovery becomes an
  intervention a person answers in the live browser, via `Session.requestApproval`.
- Human "record as steps" patch proposals (`human-patch.json`). The actions are already captured
  with agent-grade locators and written to the event log; turning them into a proposed artifact patch
  is artifact authoring, which belongs with the catalog work in slice 012.

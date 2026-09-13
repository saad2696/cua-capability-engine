# Tasks
- [x] 8.1 Vite React JS scaffold, router, layout, theme tokens
- [x] 8.2 API client + SSE + WS hooks
- [x] 8.3 Runs page
- [x] 8.4 Live Session: viewport, control bar, context panel, event log, dialog banner
- [x] 8.5 Interventions inbox with claim
- [x] 8.6 Artifact viewer + approve
- [x] 8.7 `pnpm dev:console`; README "Operator console" section with screenshots
- [ ] 8.8 Manual E2E: G2 discovery pauses at confirm, operator takes control, confirms, hands back, run completes; optional GIF for evidence
- [x] 8.9 "New run" form on the Runs page: goal, target URL, params, Discover / Replay (choose saved capability); runs start from the console via the server API
- [x] 8.10 `pnpm demo`: one command starts target app + engine server + console and opens http://localhost:4300 (the demo gateway)
- [x] 8.11 Entry gate: landing page pre-filled with the demo portal URL, demo goals (G1 read-only, G2 risky), and parameters; one click starts discovery or replay
- [x] 8.12 Activity shell: live event stream grouped by phase (observe / decide / act / record / replay step), artifact "building" view that fills in steps as they are recorded, replay step-by-step progress with pass/fail/recover badges
- [x] 8.13 Scenario panel: buttons to inject each fault (not found, validation, permission denied, session expired, unexpected dialog, slow, server error) into the live session, and "Force human intervention" (pause now) — wired to the 7.11 API

Deferred with a reason:
- 8.8 a recorded GIF of the end-to-end handover. The flow itself is covered by an automated test
  and by two recorded runs in `evidence/`; a screen recording belongs with the video walkthrough
  rather than in the repository, where it would be a large binary nobody diffs.
- Websocket reconnect with backoff. A dropped socket already reverts control to the queue after the
  grace period, and the console reopens on navigation; automatic reconnection matters for an
  operator on a flaky network, which is not a demonstration concern.

Added beyond the plan, because watching the system work turned out to need it:
- Frames stream while the engine drives, not only while a run is stopped, with the cadence varying
  by controller.
- Each step's screenshot is announced as an event, so a console gets a frame per step for free.
- A pace control and a stop-before-the-first-step option, without which a two-second replay cannot
  be followed and the takeover path is only reachable by luck.
- An evidence browser, with screenshots steppable in order.
- `blocking_dialog`: the one fault the engine is not meant to recover from, so the panel can
  demonstrate escalation as well as recovery.

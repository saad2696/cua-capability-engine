# Design: Operator console

## Pages
- **Runs**: table of runs (id, type discover/replay, capability, status, controller, started). Row → Live Session.
- **Live Session**: 
  - Center `LiveViewport`: `<img>` fed by WS frames; border color by controller (agent blue, replay green, human orange, none grey); input listeners active only while human. Click, dblclick, keydown, wheel, and a dialog banner with Accept/Dismiss when `dialog` present.
  - Top `ControlBar`: run name, step `k/n`, controller badge, buttons Take control / Hand back (menu: same, next, abort) / Abort; disabled states follow the state machine.
  - Right `ContextPanel`: intervention reason, goal or capability description, step list with current highlighted, suggested actions.
  - Bottom `EventLog`: streamed events, filter by type, redaction indicators.
- **Interventions**: inbox of open requests with age; Claim → Live Session.
- **Artifacts**: catalog list; viewer renders contract (inputs/outputs), steps with locator candidates and risk badges, outcomes table, provenance; Approve button (calls approve endpoint) when status draft.

## Data layer
`api/client.js` (fetch + EventSource), `hooks/useLiveSession.js` (WS, frames, input sending with lease), `hooks/useRuns.js`. Shared types are imported from `packages/schema` for shape reference only.

## Edge cases
- WS reconnect with backoff; on reconnect re-request lease state.
- Frame coordinate mapping accounts for CSS scaling of the image.
- Show "another operator has control" if claim returns 409.
- Keyboard focus trapped in viewport while human controls; Esc releases focus (not control).

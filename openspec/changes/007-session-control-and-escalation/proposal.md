# Change: Session control model and human escalation

## Why
Automation must be able to pause, cede control of the *same* live session to a human, record
what they did, and resume. There must always be a single answer to "who is in control".

## What changes
`Session` with an explicit controller state machine and action lease; `InterventionRequest`
creation with context; pause/resume seam used by both discovery and replay; input forwarding
API (mouse/keyboard) that only the human controller may use; human action capture with
locator; HTTP + WebSocket server exposing runs, sessions, interventions, live frames.

## Out of scope
The React UI (slice 008). Multi-operator, auth.

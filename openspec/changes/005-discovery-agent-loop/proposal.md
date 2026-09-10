# Change: LLM-driven discovery loop and recorder

## Why
This is the "model discovers" half of the through-line and the one part that must be real.

## What changes
`LlmProvider` interface with `AnthropicProvider` and `FakeProvider`; agent loop
observe → decide → act with tool-call actions; stop conditions; token hygiene; `Recorder`
that turns the action trace into a validated `Capability`; `cua discover` command.

## Out of scope
Replay. Escalation UI (the loop raises an escalation event; slice 007 handles it).

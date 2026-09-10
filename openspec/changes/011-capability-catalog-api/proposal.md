# Change (stretch): Agent-facing capability catalog

## Why
Closes the loop on "a capability an AI agent can call". The server from slice 007 already
exists, so this is cheap and demonstrates the production invocation path end to end.

## What changes
`GET /capabilities` returns approved capabilities as tool definitions (name, description,
JSON Schema for inputs, output schema). `POST /capabilities/:id/invoke` runs replay and returns
`ReplayResult`. A tiny demo script `examples/agent-invokes-capability.ts` where a Claude tool-use
call to `member-savings-balance` is answered by the catalog. Also a `--format tools` flag on the
CLI to print the catalog as Anthropic tool definitions.

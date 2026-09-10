# Change: Mock target app "Legacy CU Core"

## Why
The brief forbids using a real bank system and asks for a proxy with a non-trivial multi-step
flow. Owning the target lets us inject every runtime error class the brief names, use hostile
markup on purpose, and later add a second tenant variant.

## What changes
A small Express app, server-rendered HTML, on port 4100:
`/login → /search → /member/:id → /member/:id/subaccount/new → /confirm → /done`.
Fault injection via `?fault=` or a `/__faults` page. Five synthetic members.

## Out of scope
Realism beyond what the flows need. No database. No real PII.

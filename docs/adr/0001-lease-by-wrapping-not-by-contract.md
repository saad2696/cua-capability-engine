# 0001 — Session leases wrap the Surface instead of entering its contract

- **Slice:** 007 (session control and escalation)
- **Status:** accepted
- **Departs from:** `openspec/changes/007-session-control-and-escalation/design.md`

## What the design called for

> Invariants: exactly one controller or none; every `act` carries a lease token; the surface
> rejects acts whose lease is not current (`CONTROL_VIOLATION`, logged).

Threading a lease token through `Surface.act` so the surface itself could refuse an action from a
stale controller.

## What was built

`LeasedSurface`, a class implementing `Surface` that holds a lease id and checks it against the
session before delegating. The `Surface` interface is untouched.

## Why

`Surface` describes how an application is perceived and driven. A desktop surface built on an OS
accessibility API has no concept of an intervention, and should not have to grow one. Threading the
token would also have meant editing every caller — `executor.ts`, `loop.ts` and both CLI commands —
so that a control-plane concern reached into code that has nothing to do with control.

Wrapping turned out to be stronger than the original plan, not merely tidier: revoking a lease
disarms every reference to that surface at once, **including one a caller captured before an
`await`**. A token checked at the top of `act` would have let an action already in flight complete
under a controller who had since handed over.

## Consequence

The same shape was reached for again in slice 009. `PolicyEnforcedSurface` is a second wrapper, and
the two compose: `LeasedSurface(PolicyEnforcedSurface(playwright))`, so a human who takes control
still passes the policy layer — where their action is recorded as an override rather than refused.

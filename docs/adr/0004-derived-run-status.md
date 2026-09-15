# 0004 — Run status is derived, never stored

- **Slice:** 007 (session control and escalation)
- **Status:** accepted

## Decision

`RunRecord.status` is a getter computed from `finishedAt`, the result, and the session state. It is
never assigned.

## Why

It was a stored field first, and runs stuck on `running` forever. Tearing a session down calls
`releaseControl`, which fires the `onChange` callback while the session state is still `running`;
the callback recomputed and wrote the field, clobbering the terminal value that had just been set.
The ordering that caused it is real and not obviously wrong at either end — the bug lived in the
seam.

A getter cannot be stale, cannot be written in the wrong order, and cannot be clobbered by a
callback firing during teardown. The general form, which came up more than once in this project: if
a value is derivable from state that already exists, derive it, and most of all where callbacks fire
during teardown.

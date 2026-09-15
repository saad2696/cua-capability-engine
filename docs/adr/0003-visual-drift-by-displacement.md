# 0003 — Visual drift measures centre displacement, not box overlap

- **Slice:** 006 (deterministic replay)
- **Status:** accepted
- **Departs from:** `openspec/changes/006-deterministic-replay/tasks.md` item 6.21

## What the plan called for

Intersection-over-union of the resolved control's box against the `recordedBBox` captured at
discovery time, as a soft signal that the UI had moved under the artifact.

## What was built

`boxSimilarity` compares centre points, scaled by the larger of the control's own dimensions and a
32px floor. The size term was dropped entirely.

## Why

IoU reported drift on every control of a page that had not changed — around 49% similarity each
time, comfortably under any threshold worth setting. Two causes. The controls in a legacy table UI
are small (a 37×14px button is typical), and IoU falls off a cliff at that scale: a two-pixel shift
halves it. And the recorder and the resolver measure slightly different boxes, so a control that
never moved still compares badly against its own recording.

Centre displacement over a scale floor answers the question the signal exists to answer — *did this
control move somewhere else on the page* — without being sensitive to which of two near-identical
boxes was measured.

## What made this visible

Nothing failed. The signal fired on a run that passed, and the finding came from reading the
evidence of a **successful** run and asking why it had anything to report. A monitoring signal that
is always on is worse than no signal, and it is the kind of defect that ships, because every test
still goes green.

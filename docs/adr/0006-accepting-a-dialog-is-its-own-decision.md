# 0006 — Accepting a dialog is its own decision, and the model needs a way to make it

- **Slice:** 010 (evidence and deliverables)
- **Status:** accepted

## What forced this

Goal G2 — open a sub-account — could not be completed by the system at all, and no test said so.

The mock application takes its final approval the way legacy banking UIs actually do, with a native
`confirm()` wired to the form:

```html
<form action="/member/:id/subaccount/open"
      onsubmit="return confirm('Open this sub-account now? This action cannot be undone.');">
```

Driven directly against the real app, clicking `Open Account` returns:

```
{"ok":false,"error":"dialog open: confirm \"Open this sub-account now? This action cannot be undone.\""}
```

The click reports **failure** with the dialog still open, and nothing has been committed. Accepting
the dialog is what opens the account. The discovery loop had no tool that could answer a dialog, so
the model's only options were to retry the click forever or give up.

## Decisions

**1. `dismiss_dialog` is a tool the model can call.** An automation system for legacy UIs that
cannot answer a confirm box cannot drive the screens that matter, because those are exactly the
screens that use one.

**2. Accepting is risky; cancelling never is.** A `confirm()` appears precisely where an
application will not let you back out, so the accept *is* the commit. Cancelling is how an agent
backs out of something it should not have started, and gating it would make the safe option the
expensive one.

**3. The accept escalates even when the click that raised it was already approved.** This was the
close call. The alternative — carry the approval forward, so the operator is asked once — avoids
what looks like the double-prompt that [ADR 0002](0002-graded-risk-classification.md) argues
against. Rejected for two reasons. ADR 0002 was about a step that *commits nothing*, and this is
the application's own last-chance prompt, whose text the operator has not yet seen; approving a
commit whose final confirmation never reached a human is precisely the outcome these gates exist to
prevent. And carrying it forward means a stored flag whose validity depends on decision ordering —
the shape that produced four separate bugs in this project (see
[ADR 0004](0004-derived-run-status.md)). Two interventions, each with its own screenshot, is also
better evidence than one plus a silent auto-accept.

The click and the accept are genuinely two decisions: while the dialog is open the operation is
still cancellable.

## What this exposed downstream

None of the following were reachable before, and each would have silently produced a wrong artifact:

- **The recorder dropped the commit entirely.** It skipped any step with `actOk: false`, which
  discarded the dialog-raising click, and `dismiss_dialog` was not in its list of recorded tools. A
  G2 artifact recorded `… Continue → extract confirmation number` — a flow that replays straight
  past the confirmation and never opens the account.
- **`pointOfNoReturn` was only ever set on a risky `click`.** The committing step here is the
  dialog, so the recorded artifact carried none, and replay would have reported `sideEffects:
  "possible"` after opening a real account.
- **A modal is not a screen.** The step's recorded precondition was a landmark signature of the page
  behind the dialog. Those landmarks are listed in the accessibility snapshot but cannot be queried
  while the dialog blocks the page, so replay failed `WRONG_SCREEN` one action short of committing.
  A dialog step records no signature; the executor takes its frame from the step that raised it.
- **The dialog matched `UNKNOWN_DIALOG` on the step that exists to answer it.** Dialog-based
  outcomes are now inert while checking a `dismissDialog` step's precondition — the same principle
  already applied to a prelude's own recovery, one step smaller.
- **Replay treated the dialog-raising click as a surface error.** When the next recorded step
  answers the dialog, the click did what it was recorded doing, and the run continues to it.

## How it is checked

`packages/engine/src/agent/discovery.test.ts`, "G2 end to end", runs the whole loop against the real
application: discovery escalates twice, records an artifact, and that artifact is then **replayed
with no model in the loop** — opening a second real account and returning a different confirmation
number, with `sideEffects: "committed"`. Before this, `committed` had only ever been produced by a
hand-written fixture.

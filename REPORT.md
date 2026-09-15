# Design write-up — Computer-Use Automation System

An LLM works out how to do a task in a legacy banking UI **once**. What it learned is recorded as a
typed, versioned **capability artifact**, which then replays **deterministically with no model in
the loop** in about two seconds. Anything irreversible, or anything the system has not seen before,
stops and hands a person the same live browser session.

The long-form reasoning, every bug worth remembering and the slice-by-slice log are in
[`docs/design-notes.md`](docs/design-notes.md); the decisions that departed from their design are in
[`docs/adr/`](docs/adr/).

---

## 1. Architecture

The three things the brief wants are in tension. Flexibility — driving a UI nobody documented, with
no API and no test ids — argues for an LLM in the loop. Determinism and auditability argue against
one anywhere near the hot path. Safety argues for a human, but a human on every run is not
automation.

The resolution is **where the model sits: it is a compiler, not a runtime.** It runs once, at
authoring time, under policy and with a human available. What it emits is an artifact a person
reviews and approves, and *that* is what runs in production.

```
goal ──▶ discovery loop ◀──▶ Claude          recorder ──▶ capability artifact
              │                                              │  (typed, versioned, approved)
              ▼                                              ▼
        Surface interface ◀──────────────────────────  replay executor (no model, ~2s)
              │                                              │
     PlaywrightSurface                              success · business_outcome
     (a11y tree + marks)                            failure · escalated
              │                                              ╎
        Legacy CU Core                          operator takes the SAME live session
```

**Key decisions, and the alternative rejected for each.**

| Decision | Rejected | Why |
|---|---|---|
| Learn once, replay forever | Agent drives every run | ~$0.07/25s becomes $0/2s, deterministic and auditable. Non-determinism is confined to authoring, where a human is already looking. |
| `Surface` interface as the only seam | Playwright calls throughout | One contract for "perceive and act". Nothing in an artifact references Playwright, so a desktop surface is an implementation, not a rewrite. |
| Accessibility tree + numbered screenshot | Raw HTML in the prompt | Legacy HTML is enormous and mostly layout. The a11y tree is what an operator perceives, flattened across frames; numbered marks let the model refer to elements by index. |
| Monorepo, TypeScript strict, Zod at every boundary | Looser typing, faster start | Every contract — artifact, result, events, policy — is a schema with an inferred type, so malformed data fails at the edge with a path, not three layers in. |

**Trade-off accepted.** Discovery is slower and costlier than writing a script by hand for one
known flow. It pays back on the second capability, on the second tenant, and every time the UI
changes — because re-discovery is a command, not a maintenance project.

## 2. Artifact schema

An artifact is a **contract**, not a transcript. It has to be reviewable by someone who will not
read a log, and executable by code with no model in it. That single requirement shaped every field.

- **Inputs and outputs are typed and declared** — `memberId: string` with a pattern, `savingsBalance: money`. Parameters are substituted at replay; the model only ever sees placeholders.
- **Secrets are references, never values.** `{ kind: "secret", name: "TARGET_PASSWORD" }` resolves from the environment at the browser, *after* the model has decided — so a credential never reaches the model, the transcript or the artifact.
- **Steps carry preconditions and expectations**, not just actions. A step asserts a screen signature before acting and a checkpoint after, which turns "the click silently did nothing" into a named `CHECKPOINT_FAILED`.
- **Locators are ranked candidate lists** — role + name, then CSS, then visual position — each with the recorder's rationale. XPath was rejected: it encodes exactly the structure a redesign changes.
- **Risk is explicit.** `risk: risky` and `pointOfNoReturn: true` are what the approval gate and the side-effect tracker read. The schema refuses `pointOfNoReturn` on a non-risky step.
- **An outcome catalog travels with the capability** — the conditions this flow knows how to recognise, and what to do about each. It is what separates "the app said no" from "we broke".
- **Provenance and status** — `draft | needsReview | approved | deprecated`, plus `approvedBy` and `approvedAt`. Unattended replay refuses anything but `approved`.

**Trade-off.** The schema is large, and the recorder has to fill it honestly. That cost is
deliberate: a thin schema would push the same decisions into hand-written glue at every call site,
where nobody reviews them.

## 3. Determinism & error handling

**Determinism** comes from removing the model, then removing ambiguity: values are resolved from
declared parameters and secrets; locators resolve through a fixed candidate order; waits are
condition-based rather than sleeps; and every step checks a precondition before acting, so a run
either proceeds on the screen it expects or stops with a named reason.

**Every run ends in exactly one of four shapes, each with its own exit code** — the decision I would
defend hardest, because it is what lets a caller automate against the system instead of parsing logs.

| Outcome | Exit | Meaning |
|---|---|---|
| `success` | 0 | Completed; typed outputs returned. |
| `business_outcome` | 0 | The *application* legitimately said no — no such member, validation rejected, not authorised. **The automation worked.** A caller branches on the code; nobody is paged. |
| `failure` | 2 | Could not proceed. Always carries a bundle: narrative, screenshots, a11y snapshot, page text. |
| `escalated` | 3 | A human is needed. |

**Recoverable conditions are handled silently and bounded**: `SESSION_EXPIRED` re-runs the login
prelude and restarts the flow; `SERVER_ERROR` reloads; a *declared* dialog is dismissed; slowness is
tolerated and flagged as `SLOW_LOAD`. The guard is `RECOVERY_LOOP` — the same condition twice at the
same step stops the run rather than retrying forever.

**Hard failures are debuggable by construction**: `WRONG_SCREEN`, `LOCATOR_NOT_FOUND` (listing every
strategy tried and what was actually visible), `CHECKPOINT_FAILED`, `UNKNOWN_DIALOG`,
`UNSAFE_RESTART` (refusing to restart a flow that already committed). Pre-flight rejects
`INVALID_INPUT`, `MISSING_SECRET`, `ARTIFACT_NOT_APPROVED` and `POLICY_VIOLATION` before a browser
opens, so a bad call costs milliseconds and `stepsRun: 0` proves nothing was touched.

**UI drift** is a soft signal, not a failure. Matching on a fallback locator emits a `drift` event;
a control that has moved relative to its recording emits `visual_drift`. Both are early warning that
the screen is changing under the artifact, visible in evidence long before anything breaks.

> One finding worth stating: visual drift was originally intersection-over-union, and it reported
> drift on *every* control of an unchanged page — legacy buttons are ~37×14px and IoU collapses at
> that scale. It was found by reading the evidence of a **passing** run and asking why it had
> anything to report. A signal that is always on is worse than no signal, and it ships, because the
> tests stay green.

## 4. Heterogeneity & multi-tenant

**Across surfaces.** `Surface` is the only thing the engine talks to: perceive (an observation of
roles, names, boxes and frames) and act (click, type, select, press, navigate, dismiss a dialog).
`PlaywrightSurface` implements it for the web. A desktop surface would implement the same interface
over an OS accessibility API plus a screen grab — and nothing else changes, because **no artifact
references Playwright, CSS or the DOM as a concept.** What does change is locator portability: `role
+ name` and visual position exist on both surfaces, while `css` is web-only. That is why locators
are a ranked list rather than one strategy — a desktop artifact simply records fewer candidate
kinds, and the resolver skips what a surface cannot answer.

**Across institutions running the same vendor application.** The realistic variation is branding and
labels, URL bases, a field the institution added, a step another one skips — not a different
application. Two options:

- *Re-discover per tenant.* Simple, but multiplies model cost and, worse, review: five institutions means five artifacts nobody can diff, each independently approved.
- *One reviewed base plus a per-tenant overlay* — label and selector substitutions, URL base, step skips, extra validation — merged into an effective artifact at load. **This is the design I chose**, and it is specified in `openspec/changes/013-cross-tenant-variant/` but **not built**.

The foundations for it are in place and load-bearing today: an artifact declares the
`allowedOrigins` it was recorded against, and pre-flight refuses to run it anywhere else, so **a
different origin is already treated as a different tenant** rather than silently accepted. The
capability is versioned, so a base can move without invalidating overlays; and `status` plus
`approvedBy` mean a tenant overlay can carry its own approval.

**Trade-off.** Overlays keep one reviewed contract and make institution differences explicit and
diffable, at the cost of a merge step and the risk of an overlay drifting from a base that changed
underneath it. Version pinning is the mitigation; it is why the artifact carries a version at all.

## 5. Escalation & handoff

**Detecting "stuck"** is not a heuristic. The engine escalates on named conditions: a step marked
`risky` under a policy that requires confirmation; an outcome whose catalog entry says `escalate`;
an undeclared dialog; a precondition or checkpoint that fails with no recovery; a recovery loop;
budget exhaustion; or the model itself declaring it cannot proceed. Anything unrecognised escalates
rather than being guessed at — an automation that dismisses unknown dialogs will eventually dismiss
something expensive.

**Taking control of the live session.** The browser outlives the request. A `Session` owns it and
issues **leases**; exactly one controller holds a valid lease at a time, and acting without one is a
logged `CONTROL_VIOLATION`. The console streams frames of the automation's own page over a
WebSocket and forwards clicks and keystrokes back, so the operator is driving the same browser —
same cookies, same frames, same scroll position — not a copy.

Leases are enforced by **wrapping** the surface rather than threading a token through `act()`. That
keeps control-plane concerns out of the perception contract, and revoking a lease disarms every
reference at once, **including one a caller captured before an `await`** ([ADR 0001](docs/adr/0001-lease-by-wrapping-not-by-contract.md)).

**Handing back.** The operator resolves the intervention with `same`, `next` or `abort`. The engine
re-observes, re-checks the precondition of the step it stopped at, and continues. The proof that it
resumed rather than restarted is in the evidence: a handover run of the balance capability completes
in **seven steps**, the same as an uninterrupted run. Time parked in an intervention does not count
against the run budget, or a long handover would fail a run that was never stuck.

**Trade-off.** A live session pinned to one process is simple and honest, and it does not survive a
restart of the engine. Durable sessions would need external browser state; the interfaces would not
change, but it was out of scope.

## 6. Safety

Everything the engine may do is declared in one validated file, `policy.yaml`, loaded by every entry
point — so editing it changes what a run does, rather than what the documentation says. Unknown keys
are rejected: a misspelled control that silently enforces nothing is worse than a startup error.

**Four enforcement layers, because each is bypassable alone:** the model's decision; the surface
boundary (**replay has no model**, so layer 1 never runs on the path that runs most often); network
request interception; and a pre-flight check that an artifact's policy is a subset of the global one.

**Points of no return get two grades, not one.** The sub-account flow posts twice — `Continue`
validates and re-renders, `Open Account` moves money. Treating both as risky asks a human to approve
a step that commits nothing, and an operator asked to approve noise clicks through the prompt that
matters at the same speed ([ADR 0002](docs/adr/0002-graded-risk-classification.md)). Approval itself
is a human decision made **once**, at review time: unattended replay refuses a draft.

**A human who takes control is not blocked by policy** — they are recorded as `policy_override`.
Refusing them would disable escalation exactly when it is needed.

**Secrets** are referenced by name and resolved at act time, so no credential enters an artifact;
`cua doctor` verifies that git is not tracking `.env` and never has — asking git rather than
`.gitignore`, because those two answers disagree precisely when a file was staged before the ignore
rule was written, and deleting it later does not help.

**Limits, stated plainly.** Screenshots are **not** masked: they render whatever was on screen,
member IDs included. The structured evidence *is* redacted and tested by walking every file a run
writes, but a grep cannot see inside a PNG — so the schema types `maskEvidenceScreenshots` as the
literal `false`, making the gap impossible to paper over. Evidence is written unencrypted with no
retention policy. The console binds to loopback and has no authentication: one trusted operator is
assumed. And the guardrails are only as good as the lists in `policy.yaml` — an irreversible button
labelled something the list does not anticipate is graded `possible` and runs, which is why the
artifact records that grade where a reviewer sees it.

## 7. Cuts

**Deliberately not built, with reasons.**

- **Multi-tenant overlays** — designed (§4), specified, not implemented. The origin check and versioning that make it possible are in.
- **Capability catalog API, confidence and stability scoring** — the schema already carries what they need (status, version, provenance, `approvedBy`). The honest answer to "how does this scale past three capabilities?" is that this is where it goes next.
- **Desktop surface** — the interface exists and constrained the design; no implementation.
- **LLM-assisted replay recovery** — deliberately excluded. Putting a model back into the replay path would undo the property the whole design exists to provide.
- **Console authentication** — loopback plus a single operator. `approvedBy` is already in the intervention record for the identity that would replace the assumption.
- **New-tab/detached-element handling and checkbox state-assert** — the page-switch guard and per-step re-resolution are in; the remaining cases have no instance in either goal flow.

**What I would build next, in order.** Screenshot masking first — every element already has a
recorded bbox, so it is contained work, and it is the only limit that would block handling real
data. Then the catalog and stability scoring, because that is what turns three capabilities into a
library somebody trusts. Then tenant overlays, driven by a second institution rather than
speculatively.

**What I would do differently.** Drive the real application end to end earlier. Goal G2 — the flow
that commits — was *impossible* for the system to complete, with the entire test suite green,
because the application takes its final approval with a native `confirm()` and the model had no tool
that could answer one. Adding that tool exposed five further defects, each of which produced a
plausible wrong answer rather than a crash ([ADR 0006](docs/adr/0006-accepting-a-dialog-is-its-own-decision.md)).
Every one of them was invisible to unit tests and obvious within a minute of driving the real UI.

# Design write-up — Computer-Use Automation System

> Working document, grown slice by slice alongside the code (see `openspec/ROADMAP.md`). Each
> section records the decision, the alternative considered, the trade-off, and the extra cases
> covered. It is trimmed to 1–3 pages before submission.

## 1. Architecture

**Shape.** One TypeScript engine (`packages/engine`) behind one contracts package
(`packages/schema`), a CLI, a mock legacy bank as the target, and a thin React operator console.
Single process, files on disk, no queues or databases. The brief explicitly does not reward
scaling infrastructure; the abstractions are what must scale.

**The seam that matters: `Surface`.** Everything that touches an application goes through one
interface (`observe`, `act`, `resolve`, `captureLocator`, `readText`, `landmarkVisible`,
dialogs, page switches). The artifact never references the implementation. `PlaywrightSurface`
is the web implementation; a desktop implementation would sit on an OS accessibility API plus a
screen grab and reuse every other module unchanged.

**Perception is the accessibility tree, not the DOM (slice 004).** The model sees a screenshot
with numbered marks and a list like `[7] button "Search"`; it acts by number. Elements come from
the browser's real accessibility tree over the Chrome DevTools Protocol, *frame by frame*, with
bounding boxes from the layout engine. Why: (a) the brief's common case is a legacy UI with no
clean DOM, no ids, framesets; (b) the accessibility tree exists on desktop too, so the same
`Observation` shape works for both surfaces; (c) screenshot + coordinates remains the universal
fallback. We confirmed the trap empirically: both the Chrome extension's accessibility search
and CDP's root tree stop at the frameset boundary and see only the `<noframes>` link. Per-frame
retrieval is mandatory and is what we implemented.

**Acting is operator-like.** Clicks are coordinate clicks at the element's center after scrolling
it into view; typing is fill-and-verify with a keyboard fallback; selects use the element under
the point. This keeps action semantics identical across "by element number" (discovery) and "by
locator" (replay) and mirrors how a desktop adapter would act.

**Discovery loop (slice 005).** One model call per step, each a fresh user message: goal,
parameters by placeholder, compact history (last 3 steps verbatim, older ones as one token each),
notices from the previous turn, the numbered element list, and the marked screenshot. We do not
accumulate tool_use/tool_result pairs, so the token budget per turn is bounded regardless of run
length; the frozen system prompt is cache-marked. The model has nine tools, one call per turn
(`disable_parallel_tool_use`). Placeholders are the key safety idea: the model types `{memberId}`
or `{TARGET_PASSWORD}`, the engine substitutes, and the value never appears in the transcript.
Extraction is a dialogue with the engine, not a free-text read: the model says what it sees and
where (row label, column header, adjacent label) and the engine immediately verifies that a
deterministic strategy re-reads the same value; if not, the model is told exactly what is missing.

**Recorder.** The trace becomes an artifact by (1) classifying typed values into `param`/`secret`
references using the placeholder the model actually typed, (2) building a screen signature per
step from the landmarks visible before it, (3) inferring `expect` from what changed after it (URL
pattern, new landmark, dialog) and choosing a matching condition-based wait, (4) splitting the
sign-in into a `login` prelude (everything through the first click after the last secret typed),
(5) pruning detours by screen-state key (a loop back to a seen screen is dropped unless it
contained data entry or extraction; no-op clicks are dropped), (6) turning verified extraction
candidates into typed outputs, and (7) seeding the outcome catalog from vendor defaults plus any
`error_seen` the model reported.

**Real run.** `evidence/discovery-g1-savings-balance/`: Claude Sonnet 5, 8 calls, 21 s, about
$0.07, producing `artifacts/member-savings-balance@1.json`. The third attempt was the one kept;
the first two taught us the lessons below.

**Problems met and how they were approached.**
- *Parameter values leaking through side channels.* The first real artifact contained the member
  id in three places we had not anticipated: the model's free-text `description`, an extraction
  anchor (the model chose the account number `10042-02`, which embeds the member id), and a
  page-header landmark ("Operator: demo") that carried the secret. Fixes: all free text is
  scrubbed back to placeholders; landmarks and extraction anchors containing any parameter or
  secret value are rejected; when the model's anchor is contaminated, the engine derives clean
  anchors from the label's tokens and tells the model why. A test now asserts no parameter or
  secret value appears anywhere in the artifact or the event log.
- *The model repeating a successful extract.* After a verified extract the model called extract
  again with identical arguments, and loop detection ended the run. Now a successful extract
  produces an explicit notice ("recorded; call done"), identical repeats are no-ops that do not
  count as a dead end, and the recorder keeps the first extract per output.
- *Two secrets with the same value.* Demo credentials are both `demo`; deriving references by
  value mapped the password step to the user secret. The placeholder the model typed is now the
  authoritative reference, value matching only a fallback.
- *Dialogs block everything.* A native `alert()` raised during load blocks the `load` event, so a
  naive `goto(url, load)` hangs forever. Navigation now waits for "commit" and then races
  `load` against dialog appearance; observation reports the dialog on top of the last known
  state; only an explicit `dismissDialog` action clears it. Dialogs are evidence, never swallowed.
- *Coordinates in framesets.* CDP boxes are in page coordinates; Playwright's `boundingBox()` is
  too. A first implementation added the frame offset twice and clicked 170px to the right of
  every control in the main frame. Fixed and covered by a test that acts through a captured
  locator and asserts the resulting screen.
- *Frameset reload after login.* Legacy apps post to `_top`; our mock now does the same so the
  nav frame reflects the signed-in state, matching the real behavior a replay must survive.

## 2. Artifact schema

See `docs/artifact-schema.md` for the field-by-field reference. The decisions:

- **Contract first.** `inputs`, `outputs`, `checkpoint` are the API a calling agent needs; the
  steps are an implementation detail it never reads. `sensitivity` on inputs defaults to `pii`
  because in a bank the safe assumption is that caller data is sensitive.
- **No sensitive literals, enforced.** Values are `param`/`secret` references. The validator
  rejects literals typed into password/SSN/PIN-like fields and SSN-shaped literals anywhere.
  The recorder asserts `provenance.redacted: true`.
- **Locators are ordered fallbacks with a written rationale.** Role+name from the accessibility
  tree first (branding-resistant, exists on desktop), then label text (legacy table-cell
  labels), visible text, an id-free CSS path (layout-bound, honest 0.35–0.5 confidence), and a
  visual box that is trusted only when its anchor text is still within 150px. Replay records
  which candidate matched: a non-primary match is a *drift* signal, not a silent success.
- **Screen signatures before acting.** Each step's `precondition` names the URL pattern and
  ≥2-of-N landmarks. A wrong screen fails as `WRONG_SCREEN` with expected-vs-observed landmarks
  instead of a mysterious locator miss two steps later.
- **Outcome catalog.** Every non-success state is declared and classified business /
  recoverable / failure with detectors and a bounded recovery. The catalog is seeded from what
  the model actually encountered during discovery, so a messy run yields a richer artifact.
- **Side effects are explicit.** `risk` and `pointOfNoReturn` on steps; `sideEffects:
  none|possible|committed` on every result, so a caller never retries a committed transfer.
- **Two versions.** `schemaVersion` with a migration chain; `capability.version` bumped on any
  step or locator change. Lifecycle `draft → needsReview/approved → deprecated`, with approval
  metadata required by the validator.

Extra cases covered by validation: duplicate step ids across preludes and steps, dangling
param/secret references, outputs pointing at non-extract steps, parse kind mismatching output
type, recoveries referencing unknown preludes, business outcomes with recoveries, actions outside
the artifact's own policy, `optional` steps that would fail instead of skip.

## 3. Determinism & error handling

Replay runs the artifact and nothing else. There is no model in the process, no network call to
Anthropic, and no prompt. The test suite asserts this negatively: a successful replay's event log
must not contain a single `decide` event. That is the property the whole design exists to buy —
the same run costs nothing, takes seconds instead of a minute, and produces the same answer.

### What a step is

Each step is six phases, in order: **precondition → risk gate → act → wait → expect → detect**.

The precondition is a screen signature, not a locator: a URL pattern plus N of M landmarks. It
answers "am I on the right screen" before asking "where is the button", so a flow that drifts one
screen off course fails with `WRONG_SCREEN` naming what it expected and what it saw, rather than
with a locator miss two steps later that looks like a broken selector.

The wait is condition-based. There is no `sleep` in the replay path. A step declares what it is
waiting for — a URL change, a landmark, a network idle — and the executor polls for it.

The expect phase is what makes a step *verified* rather than merely *performed*. A click that
succeeds mechanically but does not produce the expected screen is a failure, not a success, and
this is the difference between an automation that reports what it did and one that reports what
happened.

The detect phase runs only when a step cannot prove itself: when it has no assertions, or when one
failed. Classifying the screen after every successful step would double the accessibility-tree
traffic for no information.

### Three kinds of wrong

The error taxonomy is the substance of this slice, and it is written up in full in
[`docs/error-taxonomy.md`](docs/error-taxonomy.md). The core claim is that "it failed" is three
different statements that need three different readers.

A **business outcome** is the application giving a legitimate answer that is not the happy path.
"No member found" is data. It exits 0, carries a typed code, and the caller branches on it. An
automation that reports this as an error will be retried forever against an app that will never
change its mind, and — worse — a human will be paged for it.

A **recoverable condition** is a known, bounded deviation with a known fix: a session that expired,
a maintenance alert, a 500 page. The engine applies the declared recovery within a declared budget
and continues. Recoveries are never silent; they appear in `result.recoveries` and in the evidence
log, so a capability that quietly recovers on most runs is visible as degradation rather than
invisible as success.

A **hard failure** is everything else. It stops the run, exits 2, and writes a failure bundle: a
viewport screenshot, a full-page screenshot, an accessibility snapshot, the visible text, and a
markdown narrative naming the expected state, the observed state, and a suggested next action.
Debugging a failed replay should not require re-running it.

Crucially, all three are *artifact data*, not engine constants. A new tenant adds its own outcome
codes and detectors without touching a line of TypeScript.

### Two rules that took the longest to get right

**A recovery cannot be triggered by the screen it exists to reach.** The `SESSION_EXPIRED` detector
is "the URL is /login". But /login is also where the login prelude legitimately *starts*. The first
implementation therefore restarted the login prelude on its own first step, forever, and every test
in the suite died with `RECOVERY_LOOP` at `step:open-app`. The fix is not to weaken the detector but
to scope it: while a prelude is running, its own recovery is inert **for precondition checks** and
live **for postconditions**. Seeing the sign-in screen before typing credentials is the expected
starting state. Seeing it after submitting them means the sign-in did not stick, which is exactly
the condition the recovery is for. The distinction is between "where am I" and "did that work".

**A flow cannot be restarted after it has committed something.** Re-running a login prelude is free.
Re-running a flow that has already clicked "Open Account" is not. When a recoverable condition
appears after a point of no return, the run stops with its own code, `UNSAFE_RESTART`, rather than
replaying a committed action. This is deliberately *not* folded into `RECOVERY_LOOP`: the recovery
was sound, the restart was not, and a taxonomy that collapses those two tells the reader nothing.

### Side effects are a first-class field

Every result carries `sideEffects: none | possible | committed`. `possible` is the one that matters:
a point-of-no-return step ran, but its confirmation was never observed, so the automation genuinely
does not know whether the account was opened. Saying so is more useful than guessing either way, and
it is the field a caller must read before retrying anything. The failure narrative escalates its own
advice accordingly — "safe to retry" becomes "a human must check the account first".

### Edge cases covered beyond the brief

- **Pre-flight before the browser opens.** Bad parameters, missing secrets, an unapproved artifact,
  or origins exceeding the global policy all fail with `stepsRun: 0`, which proves nothing touched
  the target app. A bad call costs milliseconds, not a Chromium session.
- **A run lock.** The same capability cannot run twice concurrently. On a flow that opens accounts,
  double submission is the expensive bug.
- **Bounded everything.** Retries, recoveries per outcome, restarts per sequence, per-step timeout,
  and a whole-run deadline. Per-step assertion windows are clamped to the *remaining* run budget, so
  three retries of a long-timeout step cannot quietly overshoot the deadline.
- **Failure evidence is itself time-boxed.** Collecting the bundle races a short budget, because the
  page may be mid-navigation or already torn down when we get there, and Playwright's own defaults
  would otherwise stall a run for tens of seconds *after* it has already failed. A cancelled run
  skips the full-page screenshot entirely: it is not a mystery that needs debugging.
- **Drift without failure.** When a non-primary locator candidate matches, the run still succeeds but
  records which strategy was recorded and which actually matched. This is the early-warning signal
  for a UI change, visible before anything breaks.
- **Plan mode.** `cua replay --plan` prints the full step plan, risk flags, points of no return and
  fallback chains without opening a browser. A reviewer can audit what a capability would do before
  ever letting it run.
- **Parameterisation is real.** The same artifact, unchanged, returns a different member's balance
  by changing one parameter. The suite asserts both, and asserts that the parameter value appears
  nowhere in the artifact or the event log.

### A signal that fired on a page that had not changed

The visual-drift check is worth a paragraph because the first version of it was useless in an
instructive way. It began as intersection-over-union between the recorded bounding box and the
resolved one — the obvious metric. It then reported drift on *every* control on *every* run of a page
that was pixel-identical to the recording.

Two causes, both specific to the domain. A legacy app's buttons are about 37x14 pixels, and on a box
that small a two-pixel rendering difference costs half the overlap. And the recorder measures the
accessible node's box while the resolver measures the element's own, so a padded control is
legitimately larger at replay than at record time without having moved at all.

The fix was to stop measuring overlap and measure centre displacement against a floored reference
length, discarding size entirely. A monitoring signal that fires constantly is worse than no signal,
because it trains the reader to ignore it — and this one would have been *indistinguishable from
working* in a demo, since drift never fails a run. It is only visible if you look at a passing run
and ask why it is reporting anything at all.

### Two things the tests found that review did not

Writing a test for a branch the happy path cannot reach is how both of these surfaced, and both are
the kind of defect that stays invisible until the day it matters.

`UNSAFE_RESTART` was setting `sideEffects` to `possible` on its way out — narrowing a run that had
already *confirmed* a committed action down to "we're not sure". It is the one field the failure
narrative uses to decide between "safe to retry" and "a human must check the account first", so
weakening it there was precisely backwards. G1 is read-only and can never reach this branch, so the
test that caught it runs against a fixture that marks the search as a point of no return.

`--resume-from` never opened a browser. The start-up path only opened the page when the run began at
step zero, because until then every run did. A resume therefore ran its first precondition check
against no page at all and died with a `TypeError` reported as `SURFACE_ERROR` — a hard failure that
told the operator nothing. It now opens the origin either way, so a resume into a session that no
longer exists reports `WRONG_SCREEN`, and the declared session recovery re-authenticates on demand
before the run continues.

### What actually ran

`evidence/` holds eight real replay runs against the mock app, indexed in `evidence/README.md`: all
four statuses, every recovery path, and both exit codes for the identical underlying condition
(`RECOVERY_LOOP` at exit 2, and the same condition escalated to a human at exit 3, differing only in
what the caller asked for). None of them involved a model.

One known rough edge, carried into slice 007: a business outcome currently takes about twenty
seconds, because the step's full assertion window expires before the detectors are consulted. The
answer is correct and the exit code is right, but the shape is wrong — the screen already said "No
member found" in the first second. Racing detection against the first failed assertion is the fix,
and it changes step semantics enough that it belongs with the session controller rather than here.

## 4. Heterogeneity & multi-tenant

_Filled in with slices 006/013. Design intent in `openspec/changes/013-cross-tenant-variant/`._

Foundations laid: the `Surface` interface and an `Observation` built from accessibility
semantics rather than markup; locator strategies that are surface-neutral except `css`;
`app.variant` on the artifact and a documented overlay format keyed by step id.

One honest caveat on surface-neutrality, found while getting replay green. The recorder emits page
headers as landmarks with `role: "text"`, and `text` is not an ARIA role — the first replay silently
failed every one of those assertions, which is what made the login prelude look like it was expiring
its own session. Rather than drop the landmark (page headers are the most stable screen
discriminator a legacy app offers) the contract now *defines* `text` as a pseudo-role meaning "a
visible text node, matched by content", documented in `docs/artifact-schema.md`. It is honourable on
any surface, including desktop accessibility APIs where static text is likewise a first-class node
without an interactive role. The Playwright surface implements it with a text match instead of a role
match. That is a surface implementation detail, not a leak into the contract — but it was worth
writing down rather than leaving as undocumented behaviour that happens to work.

## 5. Escalation & handoff

Escalation here means handing a person the *same live browser*, not filing a ticket about a run that
already died. The session, its cookies, the logged-in operator and any half-filled form are exactly
as the automation left them, because nothing was restarted. The test that matters asserts this from
the outside: a replay that pauses for approval and then resumes finishes in seven steps, the same
count as an uninterrupted run. A restart would have had to sign in again and would show more.

### One controller, enforced

`controller` is one of none, agent, replay, or human, and `state` is one of idle, running, paused,
human_control, resuming, completed, aborted. `paused` and `human_control` are deliberately distinct:
a run can be waiting for a person with nobody yet looking at it, which is not the same as somebody
holding the browser. That difference decides whether frames are worth streaming and whether a
dropped connection should return the work to the queue.

The interesting decision was how to enforce it. The obvious approach is a lease token threaded
through `Surface.act` and every caller of it. That would have put session control into the surface
contract — and a desktop surface has no idea what an intervention is, so the abstraction that the
whole heterogeneity story rests on would have acquired a concept from the wrong layer.

Instead the lease wraps. `LeasedSurface` implements `Surface`, passes every read straight through,
and gates the four mutating calls on a lease bound at construction. The session hands the engine one
and the operator's socket another; issuing a new lease disarms every reference to the old one, even
one captured mid-await. The result is that `executor.ts` and `loop.ts` are untouched by this slice,
and the rule is impossible to forget rather than merely documented.

Reads stay open on purpose. A paused run must keep rendering for whoever is looking at it.

### Two bugs the tests found in this design

Handing back originally re-issued the engine a *new* lease. But the engine holds a single surface for
the whole run, so minting it a fresh id left its own reference stale and turned every resume into a
`CONTROL_VIOLATION`. The engine's lease is now created once and restored on hand-back; a human's is
always fresh, so a console that keeps its socket open cannot keep acting after handing back. The
test asserts both directions.

Resolving a manual pause never released the engine, because a pause has no waiting escalation to
answer — the engine is blocked inside `shouldContinue`, not inside `onEscalate`. Two different
mechanisms that look identical from the console.

A third, in the server: every run stuck on "running" forever even after finishing successfully. The
run's status was a stored field, and releasing the engine's lease during teardown fired a change
callback that recomputed it from a session still marked running — clobbering the value the `finally`
block had written a line earlier. A run's status is a function of what has happened to it, so it is
now written as one, and the whole class of bug goes away. The general lesson is the one worth
keeping: state that is derivable should be derived, especially when callbacks can fire during
teardown in an order nobody is holding in their head.

A fourth, found only because a test claimed over HTTP and then opened the socket: the disconnect
handler keyed off whether *that socket* had done the claiming, so an operator who took control one
way and dropped off the other left the intervention claimed by nobody until it expired fifteen
minutes later. It now derives from the session's state, like everything else here.

### The run clock stops

An intervention can legitimately last fifteen minutes against a five-minute run budget. Any time the
engine spends blocked on a person is added back to the deadline, and the controller is consulted
*before* the clock is tested, so a resumed run cannot trip `RUN_TIMEOUT` on the very step it just
came back to. Without this every real handover would return to a run that had already expired, and
the per-step assertion windows — clamped to the remaining budget in slice 006 — would have floored
at their minimum and failed on screens that were fine.

### What a human does is captured, not just permitted

Every operator click is hit-tested against the same accessibility tree the agent uses, and a full
multi-candidate locator is captured before the click lands, because afterwards the element may be
gone. A manual fix therefore has the same fidelity as an agent action and could be proposed as a
patch to the artifact.

Typed text is redacted by *field*, not by value. The redactor only knows the secrets it was given,
and an operator types things it has never seen — so the only safe signal is what the text is going
into, decided by the same sensitive-name heuristic the perception layer uses. An unidentified field
is treated as sensitive.

### The control plane

`cua serve` binds to loopback only: there is no authentication and the API can drive a browser.
It exposes runs, an SSE stream of the evidence log, interventions with claim and resolve, artifacts,
and a WebSocket live channel. The console in slice 008 is a client of this, and `scripts/demo-handover.mjs`
drives the entire escalation story with no UI at all — which is the check that the API is real.

Frames stream only while a run is stopped and somebody is attached. Streaming while the engine drives
would contend with its own observations over the same connection and show a blur nobody is acting on.
A pending dialog blocks screenshots entirely, so the frame carries the dialog instead of freezing.

The socket never holds a lease of its own. It asks the session to claim an intervention and gets back
a leased surface, so a console that forgets to claim simply cannot act, and the refusal is a clear
message rather than a silent write into somebody else's browser.

### Which URL the demo actually points at

The entry gate in the console takes a portal URL, and there is a real decision hiding in that. A
capability artifact carries its own `policy.allowedOrigins`, and replay pre-flight refuses to run
against anything outside them. So a URL typed into the gate could either override the artifact's
origins or be constrained by them.

It is constrained by them. The gate offers the origins the artifact already declares and pre-fills
the first; pointing a capability at an origin it was not recorded against is exactly the substitution
the policy exists to prevent, and allowing it from a text box would make the guarantee cosmetic. A
different origin is a different tenant, which is the overlay mechanism in the heterogeneity section,
not a free-text field. Discovery is the opposite case and takes any allowlisted URL, because
discovery is how an artifact learns what origin it belongs to in the first place.

### Sandbox controls for the demo

`POST /runs/:id/scenario` arms one of the mock application's faults inside the *running* browser, so
the next thing the live flow does hits it. That is what makes the console's scenario buttons a
demonstration of recovery rather than a re-run with different flags: the operator perturbs a run
already in flight. `POST /runs/:id/pause` stops a healthy run between steps for the same reason.

Running the demo with a session expiry injected mid-pause shows the whole loop: the engine stops for
approval, a human approves, the injected expiry fires, the engine re-authenticates and restarts the
flow, and the restarted flow correctly asks for approval a *second* time — because a risky step that
runs twice must be approved twice.

## 6. Safety

_Filled in with slice 009._ Already in place: the network allowlist hook on the surface aborts
any request outside permitted origins at the browser level (a hidden redirect cannot leak the
session); sensitive field values are redacted in the element list before the model or the
evidence sees them; secrets are referenced by name and resolved from the environment.

## 7. Cuts

_Finalised at the end._ Planned: desktop surface (interface only), multi-tenant overlays
(design; optional demo), console auth/multi-operator, database storage, LLM-assisted replay
recovery (bounded, stretch only).

---

### Appendix: target application choice

We built our own mock, **Legacy CU Core**, rather than automating a public site. The brief
allows it and the evaluation demands it: the interesting failures are runtime conditions
(not-found, validation, permission denied, session expiry, unexpected dialogs, slowness, server
errors) and only an owned target can trigger each deterministically. The mock is deliberately
hostile (frameset, nested tables, no ids, inline `onclick`, labels as adjacent cells, native
`confirm()` on the irreversible step) and carries a hidden fault-injection control with one-shot
and sticky modes. Synthetic data only.

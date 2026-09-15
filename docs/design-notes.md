# Design notes — the long version

The deliverable write-up is [`/REPORT.md`](../REPORT.md), kept to the three pages the brief asks
for. This file is the working record behind it: the same decisions with the full reasoning, every
bug worth remembering, and what each one changed. Written slice by slice while the work happened,
so it reads as a log rather than a summary.

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

### The goal that could not be reached, and the five defects behind it

Goal G2 — open a sub-account — could not be completed by this system at all, and the test suite was
green. That is the single most useful thing the project found, and it was found by driving the real
application rather than by reading code: a twenty-line script that clicked through to the point of
no return and printed what came back.

```
{"ok":false,"error":"dialog open: confirm \"Open this sub-account now? This action cannot be undone.\""}
```

The mock takes its final approval the way legacy banking UIs do, with a native `confirm()` on the
form. The click *fails* with the dialog still open; accepting the dialog is what opens the account.
The model had no tool that could answer a dialog, so its only moves were to retry the click until the
loop detector stopped it, or give up.

Adding `dismiss_dialog` was the small part. What it exposed was not:

1. **The recorder dropped the commit.** It skipped every step with `actOk: false` — which is the
   dialog-raising click — and did not record `dismiss_dialog` at all. The G2 artifact came out as
   `… Continue → extract confirmation number`: a flow that replays straight past the confirmation
   and never opens the account, while validating cleanly against the schema.
2. **`pointOfNoReturn` was only ever set on a risky `click`.** The committing step here is a dialog,
   so the artifact recorded none, and a replay that opened a real account would have reported
   `sideEffects: "possible"`. Nothing else catches this: the schema permits a risky step without it.
3. **A modal is not a screen.** The dialog step's recorded precondition was a landmark signature of
   the page behind it. Those landmarks appear in the accessibility snapshot but cannot be queried
   while the dialog blocks the page, so replay failed `WRONG_SCREEN` one action short of the commit.
4. **The dialog matched `UNKNOWN_DIALOG` on the very step that exists to answer it** — the same
   circularity as a prelude's own recovery from slice 006, one step smaller.
5. **Replay treated the dialog-raising click as a surface error**, ending the run before the step
   that answers the dialog.

Each of these produces a *plausible* wrong answer rather than a crash, which is why none of them
showed up until something needed the whole path to work end to end.

The design decision inside this was whether the accept needs its own approval when the click was
already approved. It does — see [ADR 0006](./docs/adr/0006-accepting-a-dialog-is-its-own-decision.md).
The alternative carries the approval forward so the operator is asked once, which is tempting given
section 3's argument against double-prompting. But that argument was about a step that commits
nothing; this is the application's own last-chance prompt, and an operator who approved a click has
not yet seen the sentence "This action cannot be undone." Carrying it would also mean another stored
flag whose validity depends on decision ordering, which is the shape that produced four separate
bugs here already.

**What this now proves.** `sideEffects: "committed"` was, until this point, only ever produced by a
hand-written fixture — the weakest claim in the submission. The G2 test now runs discovery against
the live application, records an artifact, and replays that artifact **with no model in the loop**:
it opens a second real account and returns a different confirmation number. The claim is made by the
system, not by a test author.

### What the real run did that the scripted one could not

The G2 flow is exercised twice: by a scripted provider in the test suite, and once for real by
Claude Sonnet 5 through the console's own HTTP API — 15 steps, 15 model calls, $0.14, recorded in
`evidence/discovery-g2-open-subaccount/`.

The scripted run proves the mechanism. The real one produced something the script could not have,
because the script only ever does what it was told: **the model stopped and asked for a human
before any rule fired.** On reaching the review screen it called
`assert_state(needs_human_confirmation)` of its own accord, summarising what was about to happen —
member, nickname, deposit, funding account. The two escalations that followed were the policy's:
clicking `Open Account`, and accepting the dialog. Three interventions, one of them the model's own
judgement, all three recorded in `interventions.json` with who approved them.

That asymmetry is the argument for recording discovery rather than trusting it live. The model's
caution is a nice property and not one to depend on; the artifact it produced carries `risk: risky`
and `pointOfNoReturn: true` on the two steps that matter, which is a property you *can* depend on,
because it is checked at replay by code that has no model in it.

**The three settings of one capability.** The same artifact, the same parameters:

| run | setting | result |
|---|---|---|
| `replay-g2-committed/` | approved artifact, default policy | `SUCCESS`, `side effects: committed`, 12 steps, 3.9s, exit 0 |
| `replay-g2-blocked/` | `--risky block` | `FAILURE POLICY_VIOLATION`, `side effects: none`, exit 2 |
| discovery | `discovery.onRisky: escalate` | three interventions, then completion |

One policy setting is the difference between opening an account and refusing to. The guardrail is a
property of the deployment, not of the recorded flow — which is the whole reason policy is a file
and not a constant.

The confirmation numbers differ between the runs (`CU-700001`, then `CU-700002`) because each run
really opened an account in the mock core. `committed` is now a claim the system makes about its own
behaviour rather than a value a fixture was written to contain.

### The console produced no capability

Starting a discovery from the operator console recorded events, screenshots and a session, and then
threw the result away: `RunRegistry` never called the recorder. The console is the surface whose
entire purpose is turning a goal into a capability, and it was the one surface that could not.

The cause is ordinary — the recording sequence lived inside `cua discover`, so anything that was not
the CLI silently lacked it. `finishDiscovery()` now owns writing `usage.json`, the artifact,
`artifact.json` and `run.json`, and both entry points call it. The server test asserts that a run
started over HTTP leaves an artifact behind and that it lands in the directory the server was given.

That second half was also a defect, found by writing the assertion: with the recorder wired in, the
test suite began writing capabilities into the repository's own `artifacts/` directory and
overwrote a committed deliverable on its first run. Tests now get their own artifacts directory.
It is the second time in this project that a test has quietly modified the fixtures it was reading.

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

### The console is a client, not the system

`apps/operator-console` is React and plain JavaScript on Vite, and it deliberately contains no
engine logic. It cannot take control, resolve an intervention, or decide what a run does next; each
of those is a request to the server, which owns the state machine. The test of that claim is that
`scripts/demo-handover.mjs` drives the identical flow with no UI at all — if the console held any
authority of its own, the two would be able to contradict each other.

The one thing the console is opinionated about is colour. Controller identity is carried by the
viewport border and the same three colours everywhere: green for replay, blue for the model, amber
for a human. Nothing else in the interface uses them. The single most dangerous confusion in a
shared session is believing you have control when you do not.

### What it took to make the system watchable

Building the console exposed something the engine work had not: a correct system is not
automatically a legible one. A read-only replay finishes in about two seconds and its only visible
output is a number. Four changes came out of that, and none of them are cosmetic.

Frames now stream while the engine drives, not only while a run is stopped. The earlier design
deliberately streamed only in `paused` and `human_control`, reasoning that a stream during a run
would contend with the engine's own observations for the same connection and show a blur nobody was
acting on. That reasoning was sound about cost and wrong about value: watching the automation work
is most of what makes it trustworthy to a person. The cadence now varies by controller — an operator
who has taken control needs their clicks to feel immediate, an observer only needs to follow along.

Each step's screenshot, already saved for evidence, is announced as an event. So a console gets a
frame per step at no cost to the browser at all, and those frames are literally the pictures the
engine acted on rather than an approximation taken alongside.

A **pace** control puts a deliberate wait between steps. It changes nothing about what a run does,
and the wait is excluded from the run's budget for the same reason a human pause is. Calling it
what it is — a presentation control — seemed better than pretending a two-second run is followable.

**Stop before the first step** parks a run with the application already open. Without it the
takeover path was reachable only by racing a two-second run, and the first version of it stopped
*before* the browser existed, leaving an operator looking at an empty viewport wondering what broke.

### Three bugs the console found in the engine

A **manual pause revoked the lease immediately**, so the engine could not finish the step it was
already in — and when the pause was raised before a run's first step, could not even open the page.
A pause is now a request to stop at the next safe point: control stays with the engine until it
reaches its next between-steps check, and only then does the state become `paused`.

A **modal dialog raised during an action froze the engine** rather than escalating. A native alert
blocks the page, so a Playwright action already in flight never settles and the caller waits for a
click that can no longer happen. Actions now race against dialog appearance, which turns an
indefinite hang into "the dialog is why" — something the executor can classify. A step-level timeout
backs it up for anything the surface cannot see. Legacy applications raise these on interaction
rather than on load, so this was not an exotic case; it was the main one.

A **streamed frame could catch the numbered marks half-drawn**. `observe` injects marks, photographs
the page, then removes them, and a frame captured mid-window showed an application that looked
broken. Anything that photographs the page now waits its turn.

### Sandbox controls for the demo

`POST /runs/:id/scenario` arms one of the mock application's faults inside the *running* browser, so
the next thing the live flow does hits it. That is what makes the console's scenario buttons a
demonstration of recovery rather than a re-run with different flags: the operator perturbs a run
already in flight. `POST /runs/:id/pause` stops a healthy run between steps for the same reason.

Running the demo with a session expiry injected mid-pause shows the whole loop: the engine stops for
approval, a human approves, the injected expiry fires, the engine re-authenticates and restarts the
flow, and the restarted flow correctly asks for approval a *second* time — because a risky step that
runs twice must be approved twice.

The panel needed one fault it could not recover from. Every seeded fault demonstrates recovery —
a session expiry re-authenticates, a server error reloads, a known dialog is dismissed — which
collectively make the same point twice and never show the engine deciding to stop. `blocking_dialog`
raises an *undeclared* error on the next interaction, worded like a real integration failure. The
engine classifies it as `UNKNOWN_DIALOG`, refuses to guess, and hands over the browser; the operator
clears the dialog in the live view and hands back, and the run finishes in the session it stopped
in. That is the whole thesis of the escalation design in one button, and it is the one entry in the
panel drawn differently, because it means something different.

## 6. Safety

### Policy is data, because the audience is not a programmer

Everything the runtime is allowed to do lives in one file, `policy.yaml`, validated against a Zod
schema on load and loaded by every entry point through a single `runPolicy()` — `cua replay`,
`cua discover`, and both run kinds in the server. That last part is the claim, and it is easy to get
almost right: the file started out being read only by `cua doctor`, with a test asserting it equalled
the defaults compiled into the code. That test makes the file *accurate*; it does not make it
*causal*, and a policy file that documents the constants rather than setting them is the kind of
control that passes review and protects nothing. The tests that matter now edit a temporary copy —
add a blocked path, add a risky term, switch `onRisky` to `block` — and assert the run behaves
differently. Origins are the one field passed in rather than read, because a replay's permitted
origin comes from its artifact and the suite binds the mock app to an ephemeral port. The alternative — constants spread across the modules that enforce them — reads
fine to whoever wrote it and answers no question anyone actually asks. The two questions are "what
can this thing touch?" and "what changed between these two releases?", and both are answered by
reading or diffing a single document.

The schema is `.strict()`, so an unknown key is an error rather than a shrug. This matters more for
a security control than anywhere else: `blockedUrlPatters: ["/admin"]` under a permissive parser
reads to a reviewer as a policy that blocks `/admin` while enforcing precisely nothing. Failing at
startup is the only behaviour that cannot be misread.

One field is typed as the literal `false`. `redaction.maskEvidenceScreenshots` describes masking we
did not build, and typing it as a boolean would let a deployment turn on a feature that does not
exist and believe its screenshots were clean. A gap that is loud is safer than a gap that is
configurable.

### Four gates, because each one is bypassable on its own

| Layer | Where | Why the layer above is not enough |
|---|---|---|
| Decision | the model loop | — |
| Surface boundary | `PolicyEnforcedSurface` | **Replay has no model**, so the decision gate never runs on the path that runs most often. |
| Network | Playwright interception | A redirect or an injected asset moves the session without any engine code asking it to. |
| Pre-flight | `replay/preflight.ts` | An artifact travels between environments; its declared policy has to be a subset of the one in force where it lands. |

The second layer is a wrapper implementing `Surface`, not a check inside `PlaywrightSurface`. That
is the same shape as `LeasedSurface` from slice 007, and for the same reason: `Surface` describes how
an application is perceived and driven, and a desktop surface built on an OS accessibility API has
no opinion about allowlists. The design document for this slice actually specified putting the check
inside `act` and `navigate`; following it would have contradicted a decision already made and
written up two slices earlier. The two wrappers compose —
`LeasedSurface(PolicyEnforcedSurface(playwright))` — so a human who takes control still passes
through the policy layer.

**A human is not blocked there.** This was the one genuinely hard call in the slice. An operator who
has taken control has authority the engine does not, and the reason they took control is usually
that the screen is somewhere the engine could not go — a gate that stopped them would disable
escalation exactly when it is needed. So the layer records `policy_override` with the controller's
identity and lets the action through. Refusing would produce a system that is safe and useless; this
produces one that is accountable.

### The risk classifier, and the test that nearly passed for the wrong reason

The classifier answers one question: does this action commit something a human cannot take back?
Both callers — the discovery loop, which holds a model decision and an observation, and the surface
boundary, which holds an action and a resolved element — flatten what they know into the same
`RiskSubject`. A rule implemented inside either call path would have applied to one of them only,
which is the failure this module exists to prevent.

Two findings here are worth more than the code.

**The default pattern could not match the application.** `DEFAULT_RISKY` carried `"open account"`
anchored as `^\s*(open account)\b`. The mock app's controls read `Open New Sub-Account` and
`Open Account`. The anchor matches the second and not the first, and a test written from memory —
`expect(classify("Open Account").risk).toBe("risky")` — passes while telling you nothing about
whether the guard fires on the screen it guards. The test now reads the labels out of
`apps/target-app/src/views/pages.ts` with a regex and fails if the app stops rendering a control
that matches. A safety test that quotes its own expectations is testing the test.

**A single risk grade would have made the gate worse.** The sub-account flow posts twice: `Continue`
validates and re-renders, `Open Account` moves the money. The design specified `formSubmitIsRisky:
true` against a boolean `risky`, which escalates both. That is not extra caution — an operator asked
to approve a step that commits nothing learns the prompt is noise, and clicks through the one that
matters at the same speed. So the classifier returns two grades: `risky` stops, `sideEffect:
possible` records and proceeds. The vocabulary was already there — `ReplayResult.sideEffects` has
used `none | possible | committed` since slice 003 — so an operator learns one set of words for both.
Worth being precise about what that shared vocabulary is and is not: the classifier's grade is a
*prediction* about an action not yet taken, and the result field is a *record* of what a finished run
did. The two are not mechanically coupled — the artifact carries `pointOfNoReturn`, which the
executor promotes to `possible` and then `committed` as the step succeeds — and claiming they agree
"by construction" would overstate it. [ADR 0002.](./docs/adr/0002-graded-risk-classification.md)

A third finding came from asking what each rule can actually see. `irreversibleUrlPatterns` reads a
destination, and a click does not have one before it happens — `ElementSummary` carries a role, a
name and a box, not the form its control belongs to. So that rule is live for `navigate`, and for
Enter inside a form via the page's own URL, and dead for clicks. The first version of the test hid
this by hand-feeding a `formAction` field no production caller sets, and then asserting that "both
signals fire" — true of the synthetic subject, false of anything discovery produces. The test now
builds exactly the subject `basic.ts` builds and asserts the button text carries it alone. That is
the same failure the anchored-regex bug was: the label was real and the *input* was a paraphrase.

Scoping the Enter fallback took one more turn. Falling back to the page URL for clicks as well would
have been the obvious generalisation and would have been wrong: the confirmation page is served
*from* `/member/:id/subaccount/open`, so "Return to Member" on it would read as a second commit. The
fallback is scoped to Enter, and there is a test named for that page.

The cost is stated rather than hidden: an irreversible button labelled something the list does not
anticipate runs unattended. Three things bound it — the artifact records `sideEffects: possible`
where a reviewer sees it, `riskyStepsRequire: humanConfirm` pauses on every risky step regardless of
grade, and a model-flagged step is honoured whatever its text says.

### `cua doctor`, and the check that asks the right question

This repository is published at the end of the exercise with a real API key in a local `.env`, so
the check that matters is whether git is tracking it. `doctor` asks `git ls-files` and `git log
--all -- .env`, not `.gitignore`. A `.gitignore` entry proves an intention; the two disagree exactly
when a file was staged before the rule was written, which is the case that leaks — and deleting the
file at the tip does not help, because history keeps it. Both states are tested against throwaway
repositories built in the test: one where `.gitignore` names a file git is still tracking, one where
a key was committed and then removed. The naive check passes both.

A second finding came from running it: the first version failed on `.env.example` because
`TARGET_USER=demo` has a value. Those are the mock app's synthetic logins and are meant to be
committed. A checker that cries wolf on the one file that has to stay readable gets ignored, so the
rule is now narrow — credential-shaped names must be blank, password-shaped names get a warning that
names the value so a human can see at a glance that it is still `demo`.

### A guardrail that throws is not yet a typed outcome

Two new failure paths went in with tests asserting they throw — `PolicyLoadError` when the file will
not parse, `PolicyViolation` when the surface refuses an action. Both tests passed, and both were
measuring the wrong thing. `docs/error-taxonomy.md` promises that every outcome is one of four typed
results with a defined exit code, and "it throws" is not one of them. Running the actual command
showed a raw Node stack trace and exit 1; the server turned the same error into a 500, as though an
operator's typo in `policy.yaml` were a server fault. Both now produce the taxonomy's answer — exit 2
with the issues listed, 400 with the same issues — and there are tests at the boundary rather than
at the throw site.

The general shape, which is the third time it has come up in this project: a test that asserts an
internal mechanism fires says nothing about what a caller sees. The lease tests, the redaction test
and now this one all had to be rewritten to assert at the edge.

### What is redacted, and what is not

Secrets are referenced by name in an artifact and resolved from the environment at act time, so no
credential is ever written into a capability. Substitution happens at the surface, after the model
has produced its decision, so the value never reaches the model either. Every structured file
written as evidence passes the redactor, and a test walks every file a handover produces — added
after `interventions.json` was found being written with `redact=false`, which put a member ID in a
captured URL. That was the third redaction leak found in this project, which is the argument for the
test that enumerates files rather than checking the ones you thought of.

Screenshots are the honest gap. They render whatever was on screen, member IDs included, and the
`grep -r 10042 evidence/` that the evidence README used to cite as proof cannot see inside a PNG.
The claim there now separates the structured files, where it holds and is tested, from the pixels,
where it does not. Everything on screen is synthetic — which is what makes publishing these
screenshots safe here, and is not an argument that it would be safe anywhere else.

The remaining limits are in the README: evidence is written unencrypted with no retention policy,
and the console has no authentication, binding to loopback and assuming a single trusted operator.
The intervention record already carries an `approvedBy` field for the identity that would fix the
second one.

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

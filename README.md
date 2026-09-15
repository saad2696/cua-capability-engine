# CUA Capability Engine

A computer-use automation system for legacy back-office applications that have no API.
An LLM figures out how to complete a task inside the UI **once**, the run is recorded as a
typed, versioned **capability artifact**, and from then on the artifact is **replayed
deterministically** with no model in the loop. When automation cannot safely proceed, a human
operator takes control of the *same* live browser session and hands it back.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how
> the AI agent invokes it in production.

Built for the interface.ai take-home. Design write-up: [REPORT.md](./REPORT.md). Evidence of
real runs: [evidence/](./evidence/). Planning tree: [openspec/](./openspec/ROADMAP.md).

## Status

Slice-by-slice build. See [openspec/ROADMAP.md](./openspec/ROADMAP.md) for what is done.

| Slice | Name | Status |
|---|---|---|
| 001 | Scaffold monorepo | done |
| 002 | Mock target app "Legacy CU Core" | done |
| 003 | Capability artifact schema | done |
| 004 | Surface abstraction and perception | done |
| 005 | LLM discovery loop and recorder | done |
| 006 | Deterministic replay | done |
| 007 | Session control and escalation | done |
| 008 | Operator console | done |
| 009 | Policy guardrails | done |
| 010 | Evidence, README, REPORT | in progress |

## Quick start

Prerequisites: Node 22+, pnpm 11+.

```bash
pnpm install
pnpm build
pnpm test
```

Configuration lives in `.env` (gitignored). Copy the template and fill in what you need:

```bash
cp .env.example .env
pnpm cua doctor          # confirms no secret is tracked and policy.yaml is valid
```

| Variable | Needed for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | discovery only | Replay never calls a model. Tests use a fake provider. |
| `CUA_MODEL` | discovery | default `claude-sonnet-5` |
| `TARGET_APP_URL`, `TARGET_USER`, `TARGET_PASSWORD` | discovery, replay | mock app defaults: `http://localhost:4100`, `demo` / `demo` |
| `CUA_HEADLESS` | both | `false` to watch the browser |

## Run the target app

The automation target is a mock credit-union back-office app, **Legacy CU Core**, built to look
like the real thing: a frameset shell, table layouts, no element ids, inline `onclick` handlers,
labels as adjacent cells, and a native `confirm()` on the one irreversible step.

```bash
pnpm dev:target          # http://localhost:4100  sign in with demo / demo
```

Flow: Sign In → Member Search → Member Detail (balances) → Open New Sub-Account → Review and
Confirm → Sub-Account Opened. Members: 10042, 10077, 10101, 10233, 10999 (synthetic data only).

**Fault injection** lets you trigger every runtime error class on demand. Add `?fault=<name>` to
a request (that request only) or arm a one-shot fault for a later request at
`http://localhost:4100/__faults` (tick *Sticky* to keep it firing).

| fault | fires at |
|---|---|
| `not_found` | member search results |
| `validation` | sub-account form submit |
| `permission_denied` | member detail page (403) |
| `session_expired` | any authenticated page (redirects to sign-in) |
| `unexpected_dialog` | next page render (native alert) |
| `slow` | any page (6 s delay, `TARGET_FAULT_SLOW_MS` to change) |
| `server_error` | any authenticated page (500) |

`POST /__reset` restores the seed data.

## Capability artifacts

Saved capabilities live in `artifacts/` as `<id>@<version>.json`. The schema is the focal
point of the design; read [docs/artifact-schema.md](./docs/artifact-schema.md). A hand-authored
reference example is at `artifacts/examples/member-savings-balance@1.json`.

```bash
pnpm cua artifact validate artifacts/examples/member-savings-balance@1.json   # migrate + validate, JSON-path issues
pnpm cua artifact summary  artifacts/examples/member-savings-balance@1.json   # contract + plain-English steps for review
```

## How the agent sees a page

The engine never hands the DOM to the model. It reads the browser's **accessibility tree**
(over the Chrome DevTools Protocol, frame by frame, because framesets hide their children from
the root tree), takes bounding boxes from the layout engine, and draws numbered marks on a
screenshot. The model gets the marked image plus a list like `[3] button "Sign In"` and acts by
number. Try it on any URL:

```bash
pnpm cua observe http://localhost:4100/                 # writes evidence/observe-<timestamp>/
pnpm cua observe http://localhost:4100/ --headed        # watch the browser
```

Output: `screenshot-marked.png`, `screenshot.png`, `observation.json` (elements, frames,
dialog state). A sample is committed at `evidence/observe-legacy-cu-core-login/`.

## Demo path

```bash
# 1. start the mock bank app (leave it running)
pnpm dev:target

# 2. LLM-driven discovery: Claude drives the UI, the run is recorded as a capability artifact
pnpm cua discover \
  --goal "Look up member {memberId} and read the current balance of their Savings account." \
  --url http://localhost:4100/ --capability-id member-savings-balance --param memberId=10042 \
  --evidence-name discovery-g1-savings-balance
#    -> artifacts/member-savings-balance@1.json, evidence/discovery-g1-savings-balance/

# 3. deterministic replay: no model, no network, same answer
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10042 --allow-draft
#    -> SUCCESS  outputs: {"savingsBalance":{"amount":1234.56,"currency":"USD"}}   exit 0

# 4. the same artifact, a different member — parameters are real
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10077 --allow-draft

# 5. the control plane: runs, live events, interventions, take-control
pnpm cua serve
```

### Goal G2 — the flow that actually commits something

G1 reads a balance, so nothing it does can be wrong in a way that matters. G2 opens a sub-account.
The application's point of no return is a native `confirm()` dialog, and the engine stops for a
human twice on the way to it: once for the button whose label matches the irreversible list, and
again for the dialog itself, which is the step that really opens the account.

```bash
pnpm dev:target                       # terminal 1
pnpm cua serve                        # terminal 2
node scripts/demo-g2.mjs              # terminal 3 — plays the operator over the console's own API
#    -> 3 interventions, each approved by "operator-1"
#    -> artifacts/member-open-subaccount@1.json, evidence/discovery-g2-open-subaccount/
```

Then approve it once and run it unattended — this is the production shape, where the human decision
is made at review time rather than on every run:

```bash
curl -X POST http://127.0.0.1:4200/api/artifacts/member-open-subaccount@1.json/approve \
  -H 'content-type: application/json' -d '{"by":"operator-1"}'

pnpm cua replay artifacts/member-open-subaccount@1.json --param memberId=10042
#    -> SUCCESS  outputs: {"confirmationNumber":"CU-700002"}  (12 steps, side effects: committed)

# the same artifact and parameters, one policy setting different
pnpm cua replay artifacts/member-open-subaccount@1.json --param memberId=10042 --risky block
#    -> FAILURE POLICY_VIOLATION  (side effects: none, exit 2)
```

The confirmation number changes every run because each run really opens an account in the mock core.
That is what `side effects: committed` means, and the pair above is the whole safety argument in two
commands: the guardrail is a property of the deployment, not of the recorded flow.

## The operator console

```bash
pnpm demo            # the mock bank, the engine, and the console, on one command
```

Then open <http://localhost:4300>. Add `--headed` to also watch the real Chromium window.

The console owns no engine logic. It cannot take control, resolve an intervention, or decide what a
run does next — every action is a request to the server, which owns the state machine. That is why
the headless script above and this UI can drive the same run without either being the authority.

**Start** is the entry gate. Replay a recorded capability, or discover a new one with a model.
Replay offers only the origins the artifact was recorded against, because pointing a recorded flow
at a different origin is exactly what its policy exists to prevent; discovery takes any allowlisted
URL, because discovery is how a capability finds its application in the first place.

**The live session** puts the application and what is being done to it side by side. The viewport
border says who is driving: green for replay, blue for the model, amber for you. Frames stream from
the automation's own browser, faster while you hold control than while you are only watching.

Two controls make a replay watchable, because it otherwise finishes in about two seconds:

- **Pace** puts a beat between steps. It changes nothing about what the run does, and the wait is
  excluded from the run's own time budget.
- **Stop before the first step** parks the run with the application already open, so taking control
  is not a race. It is also the cautious way to run a capability for the first time.

**Break something** arms a fault inside the running browser, so the flow hits it on its next
request. Most of them the engine handles by itself. One — "Undeclared error on the next click" — it
cannot, so it stops and hands you the browser.

**Evidence** lists what the run wrote. Screenshots step through in order, so you can see every
screen the engine acted on.

**Capabilities** renders an artifact for review: its contract, every step with its locator fallbacks
and risk flags, and the outcomes it knows how to handle. Approving one is what allows it to replay
unattended.

Approving a capability is part of the demo, not a setup step: `member-savings-balance@2` ships as a
draft, so unattended replay refuses it until somebody approves it on the Capabilities page.

### Demo path, in order

| Do this | It shows |
| --- | --- |
| Replay `member-savings-balance@2` for member `10042` | Deterministic replay. Seven steps, no model, about two seconds. |
| Replay it for `10077` | The same artifact returns $8,900.04. Parameters are real, not baked in. |
| Replay for `99999` | A business outcome, `MEMBER_NOT_FOUND`, exit 0. Not an error. |
| Replay with "Session expired" | The engine notices and re-runs the login prelude by itself. |
| Replay with "Undeclared error on the next click" | It stops, names what it saw, and asks for a person. |
| Take control, dismiss the dialog, hand back | The run finishes in the session it paused in. |
| Discover with the scripted model | An artifact being recorded, values becoming references. |

The synthetic members are `10042` (Alex Sample, Savings $1,234.56), `10077` ($8,900.04), `10101`
($45,000.00), `10233` (restricted, $0.00) and `10999`. `99999` does not exist.

### Escalation: a human takes over the same live session

This is the part the brief cares about most, and it runs with no UI at all. With the target app and
`cua serve` both running:

```bash
node scripts/demo-handover.mjs --fault session_expired
```

```
1. starting a replay of member-savings-balance@2 for member 10042
2. the engine stopped and asked for a person: risky_step at step:click-button-search
   run state is now paused — nobody is driving
3. arming "session_expired" inside the live browser while the run is parked
4. taking control over the websocket
   input before claiming is refused: "claim an intervention before sending input"
   claimed; run state is human_control
   receiving live frames of the automation's own browser: 38KB at http://localhost:4100/
5. handing control back with resumeAt=same
   approved again after a restart (2 total)
6. the same session finished: success
   outputs {"savingsBalance":{"amount":1234.56,"currency":"USD"}}
   recoveries SESSION_EXPIRED via prelude:login
   12 steps, side effects none, handoffs 2
```

The browser is never restarted. Without the injected fault the run finishes in seven steps, the same
count as an uninterrupted replay, which is how you can tell the handover resumed the session rather
than starting a new one.

### The API

Loopback only: there is no authentication and it can drive a browser.

```
GET  /api/runs                         GET  /api/runs/:id
POST /api/replay                       POST /api/discover
GET  /api/runs/:id/events              server-sent events: the evidence log, live
POST /api/runs/:id/pause               stop a healthy run between steps
POST /api/runs/:id/scenario            arm a fault inside the running browser
POST /api/runs/:id/abort
GET  /api/interventions                POST /api/interventions/:id/claim
POST /api/interventions/:id/resolve    {"resumeAt":"same|next|abort","note":"..."}
GET  /api/artifacts                    GET  /api/artifacts/:file
WS   /ws/runs/:id/live                 frames out, mouse/keyboard/dialog in
```

```bash
curl -s localhost:4200/api/artifacts
curl -s -X POST localhost:4200/api/replay -H 'content-type: application/json' \
  -d '{"artifactPath":"member-savings-balance@2.json","params":{"memberId":"10042"}}'
curl -s -N localhost:4200/api/runs/<runId>/events
```

### Replay, and what it does when things go wrong

Every run ends in one of four states. Exit codes let a caller branch without parsing anything:
`0` success, `0` business outcome, `2` failure, `3` escalated.

```bash
# a legitimate "no" from the application — data, not an error (exit 0)
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=99999 --allow-draft
#    -> BUSINESS_OUTCOME MEMBER_NOT_FOUND

# the session expires mid-flow: the engine re-runs the login prelude and finishes (exit 0)
pnpm cua replay ... --param memberId=10042 --allow-draft --fault session_expired
#    -> SUCCESS   recoveries: SESSION_EXPIRED via prelude:login

# the same condition, but it never clears: bounded, then reported (exit 2)
pnpm cua replay ... --param memberId=10042 --allow-draft --fault session_expired:sticky
#    -> FAILURE RECOVERY_LOOP at step:click-button-sign-in

# an undeclared dialog blocks the run (exit 3, escalates as the outcome catalog declares)
pnpm cua replay ... --param memberId=10042 --allow-draft --fault unexpected_dialog
```

`--fault <name>[:sticky]` arms the mock app's fault injector for the run, so every branch above is
reproducible on a laptop. The faults are `not_found`, `validation`, `permission_denied`,
`session_expired`, `unexpected_dialog`, `slow`, and `server_error`.

Every failure writes a bundle to `evidence/<run>/`: a viewport screenshot, a full-page screenshot,
an accessibility snapshot, the visible text, and a markdown narrative naming the expected state, the
observed state, and the suggested next action. Read
[docs/error-taxonomy.md](./docs/error-taxonomy.md) for the full list.

### Audit a capability before letting it run

```bash
pnpm cua replay artifacts/member-savings-balance@2.json --plan
```

`--plan` opens no browser. It prints the inputs, outputs, required secrets, allowed origins, every
step with its intent, precondition, expectations and fallback locator chain, plus risk flags and
points of no return. A reviewer can see exactly what a capability would do before approving it.

Other flags: `--headed` to watch, `--json` for machine output, `--resume-from <n>` to start the main
flow partway through, `--escalate-on-failure` to hand a failure to a human instead of exiting,
`--timeout <ms>` for the whole-run budget.

Add `--headed` to watch the browser. Goals name parameters as `{memberId}`; the model types
placeholders and the engine substitutes values, so parameter and secret values never reach the
model transcript or the artifact.

### Discovery output

```
discover member-savings-balance  provider=anthropic/claude-sonnet-5
  1. type {TARGET_USER} into [1] textbox "User Name"
  2. type {TARGET_PASSWORD} into [2] textbox "Password"
  3. click [3] button "Sign In"
  4. type {memberId} into [2] textbox "Member ID"
  5. click [5] button "Search"
  6. extract savingsBalance = "$1,234.56"
  7. done: ...
  artifact: artifacts/member-savings-balance@1.json (draft; 3 steps, 1 prelude(s), 0 pruned)
  completed in 21s; 8 model calls, 30754 in / 1049 out tokens (~$0.072)
```

The recorder splits the sign-in into a `login` prelude with secret references, turns the typed
member id into a `{param}` reference, infers per-step preconditions and expectations from what
was on screen, verifies the extracted value can be re-read deterministically (table row + column
first, regex fallback), prunes detours, and seeds the outcome catalog from
`artifacts/defaults/<vendor>.outcomes.json`.

## Running without live services

All tests run with no API key and no network using the fake LLM provider. The mock target app
runs locally. Replay never needs a model. The whole discovery pipeline (surface, loop, recorder,
evidence) can be exercised offline with a scripted "model":

```bash
pnpm cua discover --provider fake --fake-script examples/fake-scripts/g1-savings-balance.mjs \
  --goal "Look up member {memberId} and read the current savings balance" \
  --url http://localhost:4100/ --capability-id member-savings-balance --param memberId=10042
```

## Architecture

_Diagram and description land with slice 005/006. Summary:_ a `Surface` abstraction
(Playwright today, desktop later) feeds an observe → decide → act loop; a recorder turns the
successful trace into an artifact; a replay executor runs artifacts with locator fallbacks,
checkpoints, and an explicit error taxonomy; a session controller lets a human take over the
same live session; policy enforces an allowlist and redaction throughout.

## Repository layout

```
apps/cli                cua command line
apps/target-app         mock legacy bank used as the automation target (synthetic data only)
apps/operator-console   React operator console
packages/schema         artifact + result contracts (Zod + TS), no engine deps
packages/engine         surface, perception, llm, agent, recorder, replay, policy, session, escalation, evidence, server
packages/config         shared tsconfig
artifacts/              saved capabilities
evidence/               discovery and replay runs
openspec/               planning: project.md, ROADMAP.md, one change folder per slice
```

## Testing

```bash
pnpm test        # unit + integration (vitest)
pnpm lint
pnpm typecheck
```

## Safety

Everything the engine is allowed to do is declared in one validated file, [`policy.yaml`](./policy.yaml).
Every entry point loads it — `cua replay`, `cua discover`, and both run kinds in the server — so
editing the file changes what a run does rather than only what the docs say. An invalid file stops
the run instead of falling back to defaults. Run the checker before anything else:

```bash
pnpm cua doctor          # secrets, policy, target reachability; exit 2 on any failure
```

```
  [  ok  ] .env is untracked            git ls-files reports no .env
  [  ok  ] .env absent from history     no commit has ever touched .env
  [  ok  ] no API key in tracked files  no key-shaped string at HEAD
  [  ok  ] .env.example carries no key  every credential variable is left blank
  [ warn ] .env.example passwords       TARGET_PASSWORD=demo — fine while these are the mock app's synthetic logins
  [  ok  ] policy.yaml                  1 origin(s), 3 blocked pattern(s), risky steps require approvedArtifact
```

The secret checks ask **git**, not `.gitignore`. The two disagree exactly when a file was added
before the ignore rule was, which is the case that actually leaks a key — and deleting the file
later does not help, because the history keeps it. Both states are tested against throwaway
repositories in `apps/cli/src/commands/doctor.test.ts`.

### Four gates, not one

An action has to pass every layer that applies to it. Each exists because the layer above it can be
bypassed by some legitimate route.

| # | Where | Catches |
|---|---|---|
| 1 | **Decision** — `policyGate.check` in the model loop | A tool that is not allowed, or a destination outside the allowlist, before anything happens. Emits `policy_block`, and the model is told why and made to find another route. |
| 2 | **Surface boundary** — `PolicyEnforcedSurface` | The same check where the action becomes real, so **replay passes it too** — there is no model in a replay, so layer 1 never runs. |
| 3 | **Network** — Playwright request interception | What actually leaves the browser. A redirect or an injected asset cannot carry the session to another origin even if no engine code asked for it. |
| 4 | **Pre-flight** — `replay/preflight.ts` | An artifact whose declared policy is not a subset of the global one refuses to run at all. |

A **human who has taken control is not blocked** by layer 2. The reason to take control is usually
that the screen is somewhere the engine could not go, so a gate that stopped them would disable
escalation precisely when it is needed. Their action is recorded as `policy_override` with who did
it — the auditable outcome rather than the silent one.

### Points of no return

`risk` in `policy.yaml` decides what counts as irreversible: button text, target URL, form submits,
Enter inside a form, or the model flagging the step itself. The classifier returns two grades rather
than one — `risky` (stop) and `sideEffect: possible` (record and proceed) — so that in the
sub-account flow only `Open Account`, which actually moves money, escalates, while the validation
step that merely re-renders the form does not. Escalating on both would teach an operator to click
through the prompt that matters. See [ADR 0002](./docs/adr/0002-graded-risk-classification.md).

What happens at a risky step is configurable, and differs by mode: discovery escalates to a human
(or blocks, with `discovery.onRisky: block`); replay runs it only from an **approved** artifact, or
pauses every time under `riskyStepsRequire: humanConfirm`, or never under `block`.

### Secrets and redaction

Secrets are referenced by name in an artifact and resolved from the environment at act time, so no
credential is ever written into a capability. Values are substituted at the surface, after the
model has produced its decision, so a secret never reaches the model at all. Everything written as
evidence — events, artifacts, the stored prompt, failure narratives — passes through the redactor,
and typed values into fields matching `redaction.sensitiveInputPattern` are masked whatever the
artifact declares.

### Known limits

- **Screenshots are not masked.** They render whatever was on screen, member IDs included. The
  schema types `maskEvidenceScreenshots` as the literal `false` so a deployment cannot claim the
  masking exists by flipping a flag that does nothing. Every element the engine touches has a
  recorded bbox, so blurring is a contained follow-up. See [evidence/README.md](./evidence/README.md).
- **Evidence is written to the local filesystem unencrypted**, with no retention policy. A real
  deployment wants an encrypted bucket with an expiry.
- **The console has no authentication.** It binds to loopback only and assumes one trusted operator.
  Multi-operator control needs identity, and the intervention record already has an `approvedBy`
  field waiting for it.
- **The target app holds synthetic data only** and never held anything else. That is what makes the
  screenshots in this repository safe to publish; it is not an argument that they would be safe from
  a real core banking system.

## Docs

- [openspec/project.md](./openspec/project.md) — decisions and conventions
- [openspec/ROADMAP.md](./openspec/ROADMAP.md) — build order
- [docs/artifact-schema.md](./docs/artifact-schema.md) — the capability artifact, field by field, with rationale
- [docs/error-taxonomy.md](./docs/error-taxonomy.md) — the four run outcomes and every failure code, with what to do about each
- [docs/adr/](./docs/adr/) — decisions that departed from a slice's design, and what changed them
- [docs/demo-script.md](./docs/demo-script.md) — the running order for the walkthrough video, act by act
- [docs/demo-narration.html](./docs/demo-narration.html) — the walkthrough in six steps: problem, decisions, cases, extras, demo, disclaimers (print to PDF)
- [docs/diagrams/](./docs/diagrams/) — mermaid sources: the life of a capability, and the runtime components
- [policy.yaml](./policy.yaml) — everything the engine is allowed to do, in one validated file

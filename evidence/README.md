# Evidence

One directory per run. Each contains `events.jsonl` (structured, redacted), `screenshots/`
(one before/after pair per step; discovery screenshots carry the numbered marks the model saw),
`run.json`, and for discovery runs `trace.json`, `usage.json` (model, tokens, cost) and
`artifact.json` (the capability produced).

| directory | what it shows |
|---|---|
| `observe-legacy-cu-core-login/` | perception of the sign-in page: a11y elements across frames + marked screenshot |
| `discovery-g1-savings-balance/` | **real LLM-driven discovery** (Claude Sonnet 5) of goal G1; produced `artifacts/member-savings-balance@1.json` |
| `discovery-g1-fake-provider/` | the same pipeline driven by the scripted fake provider (offline demo, no API key) |

## Replay runs (slice 006)

All eight ran against the mock app with no model in the loop, from the same artifact
(`artifacts/member-savings-balance@2.json`). Nothing was edited between runs except the parameter
and the injected fault, so the directories are directly comparable.

| directory | invoked with | result | exit |
|---|---|---|---|
| `replay-g1-success/` | `--param memberId=10042` | `SUCCESS` — savingsBalance $1,234.56, 7 steps, no drift, side effects `none` | 0 |
| `replay-g1-other-member/` | `--param memberId=10077` | `SUCCESS` — $8,900.04 from the same artifact, unchanged. Parameters are real, not baked in | 0 |
| `replay-g1-member-not-found/` | `--param memberId=99999` | `BUSINESS_OUTCOME MEMBER_NOT_FOUND` — the app's legitimate "no", reported as data | 0 |
| `replay-g1-session-expired/` | `--fault session_expired` | `SUCCESS` after re-running the login prelude and restarting the flow. 10 steps, one recovery | 0 |
| `replay-g1-server-error/` | `--fault server_error` | `SUCCESS` after a reload. The app's 500 page never reaches the caller | 0 |
| `replay-g1-maintenance-dialog/` | `--fault unexpected_dialog` | `SUCCESS` after dismissing a *declared* alert. An undeclared one would be `UNKNOWN_DIALOG` | 0 |
| `replay-g1-recovery-loop/` | `--fault session_expired:sticky` | `FAILURE RECOVERY_LOOP` — the condition never clears, so recovery is bounded and reported | 2 |
| `replay-g1-escalated/` | the same, `--escalate-on-failure` | `ESCALATED REPLAY_FAILURE` — the identical condition handed to a human instead of exiting | 3 |

The last two are the same fault and the same detection, differing only in what the caller asked for
when it could not proceed. That is the point of separating escalation from failure.

`replay-g1-success/plan.txt` is `--plan` output: the full step plan, preconditions, expectations,
fallback locator chains, risk flags and points of no return, produced without opening a browser.

Failure and escalation runs additionally carry the failure bundle: `failure-<step>.md` (a narrative
naming the expected state, the observed state and a suggested next action), a full-page screenshot,
a viewport screenshot, an accessibility snapshot, and the page's visible text.

## Handovers (slice 007)

Both produced by `node scripts/demo-handover.mjs` against `cua serve` — no UI involved. The search
step is marked risky, so the engine stops and asks for a person before clicking it.

| directory | what happened | steps |
|---|---|---|
| `handover-g1-approve-and-resume/` | The engine paused, an operator took control over the websocket, looked at a live frame, and handed back with `resumeAt: same`. | 7 |
| `handover-g1-scenario-injected/` | The same, but a session expiry was armed inside the running browser while it was parked. The engine re-authenticated, restarted the flow, and asked for approval a second time. | 12 |

The seven is the point. An uninterrupted replay of this capability is also seven steps, so the
handover resumed the session it paused in rather than starting a new one. The twelve in the second
run is the re-authentication and the restarted flow, not a restarted browser.

Read `events.jsonl` in either for the control trail: `control_change` records every transfer with the
lease id, `resume` records the operator's answer, and `interventions.json` holds the request an
operator saw, including who claimed it and how they resolved it.

## Goal G2 — the flow that commits something (slice 010)

G1 reads a balance; nothing it does can be wrong in a way that matters. G2 opens a sub-account, and
these three directories are the same capability at its three interesting settings.

| directory | what happened | result |
|---|---|---|
| `discovery-g2-open-subaccount/` | **Real Claude run.** 15 steps, 15 model calls, $0.14. Stopped three times for a human; each approval was given over the console's HTTP API and is recorded in `interventions.json`. Produced `artifacts/member-open-subaccount@1.json`. | `completed` |
| `replay-g2-committed/` | The same artifact after an operator approved it, replayed with **no model in the loop**. Opened a second account and read back its confirmation number. | `SUCCESS`, `side effects: committed`, 12 steps, 3.9s, exit 0 |
| `replay-g2-blocked/` | Byte-for-byte the same artifact and parameters, run with `--risky block`. | `FAILURE POLICY_VIOLATION`, `side effects: none`, exit 2 |

The last two are the point. Same capability, same inputs, one policy setting different, and the
difference is whether an account gets opened at all — the guardrail is a property of the deployment,
not of the recorded flow.

**Three escalations, and the first one was the model's own idea.** It called
`assert_state(needs_human_confirmation)` on reaching the review screen, before any rule fired. The
other two were the policy: clicking `Open Account`, whose label matches the irreversible list, and
accepting the `confirm()` dialog the application raises — which is the step that actually opens the
account, and which the engine treats as a separate decision because the operator who approved the
click had not yet seen the words "This action cannot be undone".

The confirmation numbers differ between runs (`CU-700001` from discovery, `CU-700002` from replay)
because each run really did open an account in the mock core. That is what `committed` means here,
and it is the one claim in this repository that could not be made honestly by a fixture.

## Every run directory

The tables above say what each run is *for*. This one is generated from the run files themselves, so
it cannot drift from what is actually on disk — if a directory is here with no summary, or missing
from here entirely, that is a real fact about the evidence rather than a stale sentence.

<!-- BEGIN generated run index — `cua evidence index` -->

_16 runs. Regenerate with `pnpm cua evidence index`._

| run | kind | outcome | detail | steps | notes |
| --- | --- | --- | --- | --- | --- |
| `discovery-g1-fake-provider/` | discovery | COMPLETED | /tmp/cua-offline-artifacts/member-savings-balance-offline@1.json | 7 | scripted · — |
| `discovery-g1-savings-balance/` | discovery | COMPLETED | artifacts/member-savings-balance@1.json | 8 | claude-sonnet-5 · $0.0720 |
| `discovery-g2-open-subaccount/` | discovery | COMPLETED | artifacts/member-open-subaccount@1.json | 15 | claude-sonnet-5 · $0.1447 |
| `handover-g1-approve-and-resume/` | handover | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 7 | 1 intervention: RISKY_STEP_NEEDS_APPROVAL→resolved |
| `handover-g1-scenario-injected/` | handover | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 12 | 2 interventions: RISKY_STEP_NEEDS_APPROVAL→resolved, RISKY_STEP_NEEDS_APPROVAL→resolved |
| `observe-legacy-cu-core-login/` | observation | CAPTURED | http://localhost:4100/ | 4 elements | — |
| `replay-g1-escalated/` | replay | ESCALATED REPLAY_FAILURE | RECOVERY_LOOP: at most 1 recovery(ies) for SESSION_EXPIRED — SESSION_EXPIRED triggered 2 times at this step | 6 | side effects: none |
| `replay-g1-maintenance-dialog/` | replay | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 7 | side effects: none |
| `replay-g1-member-not-found/` | replay | BUSINESS_OUTCOME MEMBER_NOT_FOUND | {} · No member exists with this member ID. | 5 | side effects: none |
| `replay-g1-other-member/` | replay | SUCCESS | {"savingsBalance":{"amount":8900.04,"currency":"USD"}} | 7 | side effects: none |
| `replay-g1-recovery-loop/` | replay | FAILURE RECOVERY_LOOP | — | 6 | side effects: none |
| `replay-g1-server-error/` | replay | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 7 | side effects: none |
| `replay-g1-session-expired/` | replay | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 10 | side effects: none |
| `replay-g1-success/` | replay | SUCCESS | {"savingsBalance":{"amount":1234.56,"currency":"USD"}} | 7 | side effects: none |
| `replay-g2-blocked/` | replay | FAILURE POLICY_VIOLATION | — | 10 | side effects: none |
| `replay-g2-committed/` | replay | SUCCESS | {"confirmationNumber":"CU-700002"} | 12 | side effects: committed |

<!-- END generated run index -->

## What is and is not redacted

No parameter or secret value appears in any **structured** file in this directory — `events.jsonl`,
`run.json`, `artifact.json`, `interventions.json`, `usage.json` and the failure narratives all pass
through the redactor, and the test suite walks every file a handover writes to assert it. Checked
directly: `grep -rn 10042 evidence/ --include='*.json*' --include='*.md' --include='*.txt'` matches
only this README's own prose.

**Screenshots are not redacted, and the grep above cannot see inside a PNG.** Every member-detail
capture renders the member ID and name exactly as the page drew them. This is a real limit, not an
oversight: `policy.yaml` pins `redaction.maskEvidenceScreenshots` to `false`, and the schema types
it as the literal `false` so it cannot be set to `true` by a deployment that has not built the
masking. The engine records a bbox for every element it touches, so blurring the sensitive ones is a
contained follow-up rather than a redesign — see the "Known limits" section of the README.

Everything on screen here is synthetic. `apps/target-app` ships fabricated members and balances and
has never held real data, which is what makes publishing these screenshots safe in this repository
and is not an argument that it would be safe in a real one.

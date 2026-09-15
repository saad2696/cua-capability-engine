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

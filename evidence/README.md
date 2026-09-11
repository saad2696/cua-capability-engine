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

No parameter or secret value appears in any file in this directory. The test suite asserts it, and
`grep -r 10042 evidence/replay-*` returns nothing.

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

Replay runs (success, business outcome, recovered, failure, escalated) are added by slices 006–008.

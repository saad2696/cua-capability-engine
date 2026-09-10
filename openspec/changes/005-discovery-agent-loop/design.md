# Design: Discovery loop

## Provider seam
```ts
interface LlmProvider { decide(ctx: DecisionContext): Promise<Decision>; }
type Decision = { tool: ToolName, args, reasoning: string, usage };
```
`AnthropicProvider` uses `@anthropic-ai/sdk` messages with tools, image input, default model
`claude-sonnet-5`, `max_tokens` modest, adaptive thinking off by default for cost (configurable).
`FakeProvider` replays a scripted decision list; used in all tests and in CI.

## Tools the model can call
`click(index)`, `type(index, text)`, `select(index, value)`, `press(key)`, `navigate(url)`,
`extract(index, outputName)`, `assert_state(kind, value)`, `done(outputs, summary)`,
`give_up(reason)`. One tool call per turn (`disable_parallel_tool_use`).

## Prompt
System: role, the goal, the input parameters by name and value, the allowlist, the rule that risky
actions (submit/confirm/delete) must be proposed via `assert_state("needs_human_confirmation")`
rather than executed, and instructions to name outputs when extracting.
User turn per step: annotated screenshot + element list + last 3 steps verbatim + one-line
summaries of earlier steps + current url/dialog.

## Loop
```
for step in 1..maxSteps:
  obs = surface.observe(); evidence.observe(obs)
  d = provider.decide(ctx(obs)); evidence.decide(d)
  verdict = policy.check(d, obs)            # allowlist, action type, risk
  if verdict.block: evidence.block; escalate or stop
  if d.tool == done: finalize; break
  if d.tool == give_up: escalate("agent_gave_up")
  locator = surface.captureLocator(d.args.index)   # before acting
  res = surface.act(d); evidence.act(res)
  recorder.record(step, d, locator, before=obs, after=surface.observe())
dead-end: same (tool,args) 3x in a row → escalate("loop_detected")
```

## Recorder
- Builds `Step`s with the captured locator, `expect` inferred from the after-observation
  (url changed → `urlMatches`; typed → `valueEquals`; new heading text → `textVisible`).
- Parameter substitution: any typed text equal to a provided param value becomes `{ param }`;
  credentials become `{ secret }`. Login steps are split into `preludes.login` when they precede
  the first goal-relevant step and end with a url change away from `/login`.
- Risk: step is `risky` if the policy classified it so at decision time.
- Outcomes: seeded from a per-app default set (not found, session expired, unknown dialog,
  server error) plus any the model asserted during the run.
- Checkpoint: the final `assert_state`/`done` observation's most specific signal.
- Output: validates against the schema before writing `artifacts/<id>@<version>.json`.

## Evidence
`evidence/discovery-<runId>/events.jsonl`, `steps/NN.png` (annotated), `run.json`, `artifact.json`.
Decision `reasoning` is stored; typed values are redacted per policy.

## Recorder robustness

### Trajectory pruning
A successful discovery run often contains detours: the model clicks the wrong tab, reads a
page, comes back. The recorder builds a state graph (nodes = screen signatures, edges = actions)
and keeps the shortest path from the start node to the goal node, dropping loops and
no-op actions (an action whose before and after signatures are identical and that produced no
extract). Pruned steps are kept in `evidence/.../pruned-steps.json` for audit. The pruned
artifact is then **verified by an immediate deterministic replay** before it is saved; if the
verification replay fails, the unpruned artifact is saved instead and flagged `needsReview`.

### Semantic step descriptions
Each step stores `intent` from the model's stated reasoning, redacted and truncated
("Enter the member id into the search box"). Used for `summary` and for assisted fallback.

### Value classification at record time
Typed text is classified: equals a param → `{param}`; matches a secret from env → `{secret}`;
matches `sensitiveInputPattern` field → refused to record as literal (artifact invalid, escalate);
otherwise literal. Literal values that look like PII (SSN pattern, 9+ digit numbers, emails)
are flagged for review.

### Outcome seeding from the run
Every error page, dialog, or validation message the model *encountered and recovered from*
during discovery becomes a declared outcome with its detector, so a messy discovery run makes
a richer artifact. Undeclared app defaults are added from `apps/<vendor>/outcomes.default.json`.

### Discovery-time verification replay
`cua discover` ends with `--verify` (default on): a replay with the same params on a fresh
browser context. The artifact is saved as `draft` only if verification returns `success`;
otherwise `status: needsReview` with the verification result attached. Evidence for both is kept.

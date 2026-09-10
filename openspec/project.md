# Project: Computer-Use Automation System

Take-home for interface.ai. A system that lets an LLM discover how to complete a task inside a
legacy back-office banking UI once, records that run as a typed, versioned **capability
artifact**, and then replays the artifact deterministically (no LLM) on demand, with human
escalation when it cannot safely proceed.

Through-line: **the model discovers; the artifact becomes a reusable capability; deterministic
replay is how the AI agent invokes it in production.**

## Evaluation weights (from the brief, Section 7)

1. System design — artifact schema and replay contract are central
2. Correctness of the core loop
3. Robustness and error handling — business outcome vs recoverable vs hard failure
4. Human-in-the-loop escalation on the *same* live session
5. Generalization design — heterogeneous surfaces, multi-tenant reuse
6. Safety — allowlist, risky actions, redaction
7. Code quality
8. Communication

Hard requirements: at least one real LLM-driven discovery run with evidence in `/evidence/`;
deliverables at `/README.md`, `/REPORT.md` (seven fixed headings), `/evidence/`.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node 24, pnpm workspaces |
| Engine | TypeScript, Zod for runtime validation of artifacts |
| LLM | Claude via `@anthropic-ai/sdk`; default model `claude-sonnet-5`; `claude-opus-5` for the final evidence run if credit remains. Provider behind `LlmProvider` interface with a `FakeProvider` for tests. |
| Browser automation | Playwright (Chromium), actuation only |
| Perception | Screenshot with numbered marks + compact accessibility-tree element list. No DOM sent to the model. |
| Target app | Own mock "Legacy CU Core": Express, server-rendered, framesets/tables/no ids, fault injection |
| Operator console | React (JavaScript) + Vite, talks to engine over HTTP + WebSocket |
| Storage | JSON files: `artifacts/` (catalog), `evidence/` (runs) |
| Tests | Vitest; Playwright for replay integration tests against the mock app |

## Repository layout (target)

```
apps/target-app        mock legacy bank
apps/operator-console  React console
apps/cli               `cua discover | replay | serve`
packages/schema        artifact + result contracts (Zod + TS). No engine deps.
packages/engine        surface, perception, llm, agent, recorder, replay, policy,
                       session, escalation, evidence, server
packages/config        shared tsconfig / eslint
artifacts/             saved capabilities
evidence/              discovery + replay runs
openspec/              this planning tree
policy.yaml            allowlist + risk rules
.env.example           ANTHROPIC_API_KEY, TARGET_APP_URL, TARGET_USER, TARGET_PASSWORD
```

## Conventions

- One OpenSpec change per vertical slice; changes are numbered in build order.
- Requirements use SHALL and at least one `#### Scenario:` each.
- Every slice ends with its tasks checked and a README section updated.
- Secrets only in `.env` (gitignored). Artifacts and logs pass through the redactor.
- Fake data only in the target app. No real PII, no real credentials.
- Commit per completed slice; commit message references the change id.

## Demo goals

- **G1 (read-only):** "Look up member 10042 and read the current savings balance."
  Capability `member-savings-balance`. Replays: success, `MEMBER_NOT_FOUND`, `SESSION_EXPIRED` recovery.
- **G2 (risky):** "Open a new savings sub-account for member 10042 and reach the confirmation
  screen." The confirm step is risky, so discovery escalates to a human who confirms in the
  console and hands back.

## Planned cuts (to be listed in REPORT.md § Cuts)

Desktop surface (interface only), multi-tenant (design + optional `variant` flag in mock),
console auth, database storage, LLM-assisted replay recovery.

## Demo sandbox controls (added 2026-09-11)

The operator console doubles as a demo gateway: a pre-filled entry gate (demo portal URL, goals
G1/G2, parameters), an activity shell (live events, artifact being built, replay step progress),
and a **scenario panel** that injects corner cases into the *live automation session*: each
fault of the mock app, "force human intervention" (pause now → take control → hand back →
resume), and "abort". Implemented by slice 007 (server API) and slice 008 (UI).

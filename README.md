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
| 003 | Capability artifact schema | planned |
| 004 | Surface abstraction and perception | planned |
| 005 | LLM discovery loop and recorder | planned |
| 006 | Deterministic replay | planned |
| 007 | Session control and escalation | planned |
| 008 | Operator console | planned |
| 009 | Policy guardrails | planned |
| 010 | Evidence, README, REPORT | planned |

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

## Demo path

_Filled in as the slices land. Final form will be:_

```bash
pnpm dev:target                                   # 1. start the mock bank app
pnpm cua discover --goal "..." --url ... --param memberId=10042   # 2. LLM discovers, artifact saved
pnpm cua replay artifacts/member-savings-balance@1.json --param memberId=10042   # 3. deterministic replay
pnpm cua replay ... --param memberId=99999        # 4. business outcome: MEMBER_NOT_FOUND
pnpm cua serve && pnpm dev:console                # 5. escalation + human takeover demo
```

## Running without live services

All tests run with no API key and no network using the fake LLM provider. The mock target app
runs locally. Replay never needs a model.

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

## Safety notes

Secrets live only in `.env`. The target app contains synthetic data only. Artifacts and logs are
redacted; see slice 009 and REPORT.md § Safety.

## Docs

- [openspec/project.md](./openspec/project.md) — decisions and conventions
- [openspec/ROADMAP.md](./openspec/ROADMAP.md) — build order
- `docs/artifact-schema.md`, `docs/error-taxonomy.md` — arrive with slices 003 and 006

# Change: Scaffold the monorepo

## Why
Every later slice needs a consistent build, lint, test, and env setup. Doing it first keeps
each slice small and lets the README grow with the code.

## What changes
- pnpm workspace with `apps/*` and `packages/*`
- Shared TypeScript and ESLint config in `packages/config`
- Empty but buildable packages: `schema`, `engine`, `cli`, `target-app`, `operator-console`
- `.env.example`, `.gitignore` (node_modules, .env, evidence/**/tmp, playwright artifacts)
- README skeleton with the final section headings already in place
- Vitest wired at the root

## Out of scope
Any feature code. OpenSpec CLI tooling (can be added later with `openspec init`).

# Design: Scaffold

- pnpm workspaces, Node 24, TypeScript 5 with `"module": "NodeNext"`, ESM throughout.
- `packages/schema` has zero runtime deps except Zod so the console and any external agent can import it.
- Root scripts: `build`, `test`, `lint`, `dev:target`, `dev:console`, `cua` (runs the CLI via tsx).
- `.env` loaded only by `apps/cli` and `apps/target-app` via `dotenv`; the engine receives config as arguments, never reads env itself (keeps it testable).

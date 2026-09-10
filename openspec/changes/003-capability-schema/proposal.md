# Change: Capability artifact schema and result contract

## Why
The artifact schema is the focal point of the evaluation. It must be typed, versioned,
reviewable by humans, and callable by agents, and it must be decoupled from both the model
transcript and Playwright.

## What changes
`packages/schema` with Zod schemas and inferred TS types for `Capability`, `Step`, `Locator`,
`Outcome`, `Policy`, `ReplayResult`, `DiscoveryResult`, and evidence `Event`s. Validation CLI
`cua artifact validate <file>`. Annotated example artifact in `docs/artifact-schema.md`.

## Out of scope
Any execution logic.

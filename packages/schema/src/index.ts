/**
 * @cua/schema — contracts shared by the engine, CLI, console, and external agents.
 *
 * - capability.ts  the artifact: a typed, versioned, reviewable capability
 * - step.ts        ordered actions with multi-candidate locators and per-step checkpoints
 * - locator.ts     how controls are found, with ordered fallbacks and rationale
 * - contract.ts    typed inputs and outputs, extraction with fallbacks and parsing
 * - outcome.ts     business / recoverable / failure catalog with detectors and recoveries
 * - policy.ts      the artifact's own allowlist (must be a subset of the global policy)
 * - result.ts      ReplayResult / DiscoveryResult, failure codes, exit codes, side-effect state
 * - events.ts      evidence events (events.jsonl)
 * - validate.ts    migrate + validate with JSON-path issues
 *
 * This package depends only on zod so anything can import it.
 */
export * from "./common.js";
export * from "./locator.js";
export * from "./step.js";
export * from "./contract.js";
export * from "./outcome.js";
export * from "./policy.js";
export * from "./capability.js";
export * from "./result.js";
export * from "./events.js";
export * from "./validate.js";
export * from "./migrate/index.js";

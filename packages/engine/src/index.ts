/**
 * @cua/engine — the runtime.
 *
 * Module map (filled in slice by slice):
 *   surface/     Surface interface + PlaywrightSurface (a11y-tree perception, marks)   (004) done
 *   llm/         LlmProvider, AnthropicProvider, FakeProvider, tool definitions        (005) done
 *   agent/       discovery loop, prompts                                               (005) done
 *   recorder/    action trace -> Capability artifact                                   (005) done
 *   evidence/    run folders, events.jsonl, screenshots, redactor                      (005) done
 *   policy/      basic allowlist + risk; full policy.yaml in 009                       (005/009)
 *   replay/      preflight, executor, assertions, signatures, detectors, recovery      (006) done
 *   session/     controller state machine, leases                                      (007)
 *   escalation/  InterventionRequest, handoff, resume                                  (007)
 *   server/      HTTP + WebSocket API                                                  (007)
 */
export { SCHEMA_VERSION } from "@cua/schema";
export const ENGINE_NAME = "cua-capability-engine" as const;
export * from "./surface/index.js";
export * from "./llm/index.js";
export * from "./agent/index.js";
export * from "./recorder/index.js";
export * from "./evidence/index.js";
export * from "./policy/index.js";
export * from "./replay/index.js";
export * from "./session/index.js";

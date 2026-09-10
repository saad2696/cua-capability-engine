/**
 * @cua/engine — the runtime.
 *
 * Module map (filled in by later slices):
 *   surface/     Surface interface + PlaywrightSurface        (004)
 *   perception/  a11y snapshot, set-of-marks overlay          (004)
 *   llm/         LlmProvider, AnthropicProvider, FakeProvider (005)
 *   agent/       discovery loop, prompts, tools               (005)
 *   recorder/    action trace → Capability artifact           (005)
 *   replay/      executor, resolver, detectors, recovery      (006)
 *   session/     controller state machine, leases             (007)
 *   escalation/  InterventionRequest, handoff, resume         (007)
 *   policy/      allowlist, risk, redaction                   (009)
 *   evidence/    run folders, events.jsonl, screenshots       (005/006)
 *   server/      HTTP + WebSocket API                         (007)
 */
export { SCHEMA_VERSION } from "@cua/schema";
export const ENGINE_NAME = "cua-capability-engine" as const;

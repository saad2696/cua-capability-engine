import { z } from "zod";
import { IsoDateTimeSchema, StepIdSchema } from "./common.js";
import { LocatorSchema } from "./locator.js";

export const ControllerSchema = z.enum(["none", "agent", "replay", "human"]);
export type Controller = z.infer<typeof ControllerSchema>;

const base = {
  seq: z.number().int().nonnegative(),
  ts: IsoDateTimeSchema,
  runId: z.string().min(1),
  stepId: StepIdSchema.optional(),
  stepIndex: z.number().int().nonnegative().optional(),
};

/** Element summary as the model sees it: no DOM, just what an operator would perceive. */
export const ElementSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  role: z.string(),
  name: z.string(),
  value: z.string().optional().describe("Redacted for sensitive fields."),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  frame: z.array(z.string()),
  enabled: z.boolean().default(true),
  focused: z.boolean().default(false),
});
export type ElementSummary = z.infer<typeof ElementSummarySchema>;

/**
 * Evidence events, one per line in events.jsonl. Everything here has passed the redactor.
 */
export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), mode: z.enum(["discover", "replay"]), goal: z.string().optional(), capabilityId: z.string().optional(), ...base }),
  z.object({ type: z.literal("observe"), url: z.string(), title: z.string(), elementCount: z.number().int(), screenshot: z.string(), dialog: z.object({ type: z.string(), message: z.string() }).optional(), ...base }),
  z.object({ type: z.literal("decide"), tool: z.string(), args: z.record(z.unknown()), reasoning: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(), ...base }),
  z.object({ type: z.literal("act"), action: z.string(), target: z.string().optional(), value: z.string().optional(), controller: ControllerSchema, ok: z.boolean(), error: z.string().optional(), ...base }),
  z.object({ type: z.literal("precondition"), ok: z.boolean(), expectedLandmarks: z.array(z.string()), observedLandmarks: z.array(z.string()), ...base }),
  z.object({ type: z.literal("resolve"), matchedStrategy: z.string(), candidateIndex: z.number().int(), attempts: z.number().int(), ...base }),
  z.object({ type: z.literal("drift"), primaryStrategy: z.string(), matchedStrategy: z.string(), ...base }),
  z.object({ type: z.literal("visual_drift"), similarity: z.number(), threshold: z.number(), ...base }),
  z.object({ type: z.literal("verify"), assertion: z.string(), ok: z.boolean(), observed: z.string().optional(), ...base }),
  z.object({ type: z.literal("detect"), code: z.string(), kind: z.enum(["business", "recoverable", "failure"]), detail: z.string().optional(), ...base }),
  z.object({ type: z.literal("recover"), code: z.string(), recovery: z.string(), attempt: z.number().int(), ok: z.boolean(), ...base }),
  z.object({ type: z.literal("extract"), output: z.string(), strategy: z.string(), raw: z.string(), parsed: z.unknown(), ...base }),
  z.object({ type: z.literal("policy_block"), action: z.string(), reason: z.string(), controller: ControllerSchema, ...base }),
  z.object({ type: z.literal("policy_override"), action: z.string(), reason: z.string(), by: z.string(), ...base }),
  z.object({ type: z.literal("risk_flag"), action: z.string(), reason: z.string(), ...base }),
  z.object({ type: z.literal("escalate"), interventionId: z.string(), reason: z.string(), detail: z.string(), screenshot: z.string().optional(), ...base }),
  z.object({ type: z.literal("control_change"), from: ControllerSchema, to: ControllerSchema, by: z.string().optional(), leaseId: z.string().optional(), ...base }),
  z.object({ type: z.literal("human_action"), action: z.string(), locator: LocatorSchema.optional(), value: z.string().optional(), screenshotBefore: z.string().optional(), screenshotAfter: z.string().optional(), ...base }),
  z.object({ type: z.literal("resume"), resumeAt: z.enum(["same", "next", "abort"]), note: z.string().optional(), ...base }),
  z.object({ type: z.literal("page_switch"), from: z.string(), to: z.string(), ...base }),
  z.object({ type: z.literal("skipped_optional"), reason: z.string(), ...base }),
  z.object({ type: z.literal("pruned"), removedStepIds: z.array(z.string()), reason: z.string(), ...base }),
  z.object({ type: z.literal("assist"), proposedLocator: LocatorSchema, accepted: z.boolean(), ...base }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string(), stack: z.string().optional(), ...base }),
  z.object({ type: z.literal("result"), status: z.string(), code: z.string().optional(), summary: z.string(), ...base }),
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];

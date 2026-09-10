import { z } from "zod";
import { AssertionSchema, ScreenSignatureSchema, StepIdSchema, ValueSchema, WaitSchema } from "./common.js";
import { LocatorSchema } from "./locator.js";

export const ActionTypeSchema = z.enum(["navigate", "click", "type", "select", "press", "extract", "assert", "dismissDialog"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** Actions that are idempotent by nature may be retried; the rest default to a single attempt. */
export const DEFAULT_RETRYABLE: Record<ActionType, boolean> = {
  navigate: true, click: false, type: true, select: true, press: false, extract: true, assert: true, dismissDialog: false,
};

export const StepSchema = z
  .object({
    id: StepIdSchema,
    intent: z.string().min(1).describe("Plain-English purpose, derived from the model's reasoning (redacted)."),
    action: ActionTypeSchema,
    target: LocatorSchema.optional(),
    value: ValueSchema.optional().describe("Text to type, option to select, key to press, or URL to navigate to."),
    output: z.string().min(1).optional().describe("For `extract`: the output name this step feeds."),
    precondition: ScreenSignatureSchema.optional(),
    expect: z.array(AssertionSchema).default([]).describe("Per-step checkpoint verified after acting."),
    wait: WaitSchema.default({ for: "load", timeoutMs: 8000 }),
    risk: z.enum(["safe", "risky"]).default("safe"),
    retryable: z.boolean().optional().describe("Defaults per action type; see DEFAULT_RETRYABLE."),
    pointOfNoReturn: z.boolean().default(false).describe("Success of this step commits a side effect."),
    optional: z.boolean().default(false).describe("Skip silently when the precondition is not met (e.g. an interstitial that may not appear)."),
    onFailure: z.enum(["fail", "escalate", "skipIfOptional"]).default("fail"),
    timeoutMs: z.number().int().positive().default(10_000),
    note: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const needsTarget: ActionType[] = ["click", "type", "select", "extract"];
    const needsValue: ActionType[] = ["type", "select", "press", "navigate"];
    if (needsTarget.includes(s.action) && !s.target) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `${s.action} requires a target` });
    if (needsValue.includes(s.action) && !s.value) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${s.action} requires a value` });
    if (s.action === "extract" && !s.output) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "extract requires an output name" });
    if (s.action !== "extract" && s.output) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "only extract steps declare an output" });
    if (s.pointOfNoReturn && s.risk !== "risky") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risk"], message: "a pointOfNoReturn step must be risky" });
    if (s.optional && s.onFailure === "fail") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["onFailure"], message: "optional steps should use onFailure: skipIfOptional" });
    if (s.action === "navigate" && s.value?.kind === "secret") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "navigate cannot use a secret value" });
  });
export type Step = z.infer<typeof StepSchema>;
export type StepInput = z.input<typeof StepSchema>;

export function isRetryable(step: Step): boolean {
  return step.retryable ?? DEFAULT_RETRYABLE[step.action];
}

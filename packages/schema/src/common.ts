import { z } from "zod";

/** kebab-case identifier for capabilities, vendors, variants, preludes. */
export const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case id expected");

/** Step ids are namespaced so they are unmistakable in logs: `step:search-click`. */
export const StepIdSchema = z.string().regex(/^step:[a-z0-9][a-z0-9-]*$/, "step id must look like step:<kebab>");

/** UPPER_SNAKE outcome / failure codes. */
export const CodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "UPPER_SNAKE code expected");

export const FramePathSchema = z.array(z.string().min(1)).describe("Frame path from the top document, by frame name or index, e.g. [\"main\"].");

/**
 * A value used by a step. Literals are only allowed for non-sensitive, non-parameter data;
 * anything the caller supplies is a `param`, anything secret is a `secret` reference resolved
 * from the environment at run time. This is what keeps PII and credentials out of artifacts.
 */
export const ValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), name: z.string().min(1) }),
  z.object({ kind: z.literal("secret"), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
]);
export type Value = z.infer<typeof ValueSchema>;

/** Accessibility landmark: a role plus accessible name, the most branding-resistant handle we have. */
export const LandmarkSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1),
  exact: z.boolean().optional(),
});
export type Landmark = z.infer<typeof LandmarkSchema>;

const regexFlags = z.string().regex(/^[gimsuy]*$/).optional();

/**
 * Assertions are used for step `expect`, capability `checkpoint`, and screen-signature
 * negatives. `urlMatches` is evaluated against the frame the step targets (framesets keep the
 * top URL constant), unless `scope: "top"`.
 */
export const AssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("urlMatches"), pattern: z.string().min(1), flags: regexFlags, scope: z.enum(["frame", "top"]).default("frame") }),
  z.object({ kind: z.literal("textVisible"), pattern: z.string().min(1).optional(), value: ValueSchema.optional(), flags: regexFlags, frame: FramePathSchema.optional() }),
  z.object({ kind: z.literal("textNotVisible"), pattern: z.string().min(1), flags: regexFlags, frame: FramePathSchema.optional() }),
  z.object({ kind: z.literal("landmarkVisible"), landmark: LandmarkSchema, frame: FramePathSchema.optional() }),
  z.object({ kind: z.literal("valueEquals"), value: ValueSchema }).describe("The step's own target has this value (used after `type`/`select`)."),
  z.object({ kind: z.literal("dialogOpen"), open: z.boolean(), messageMatches: z.string().optional() }),
]).superRefine((a, ctx) => {
  if (a.kind === "textVisible" && Boolean(a.pattern) === Boolean(a.value))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "textVisible needs exactly one of pattern or value" });
});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * Screen signature: the evidence that we are on the screen a step expects, checked BEFORE the
 * step acts. At least `minLandmarks` of `landmarks` must be visible (default: 2, or all when
 * fewer are declared) so cosmetic re-branding does not break preconditions.
 */
export const ScreenSignatureSchema = z.object({
  urlPattern: z.string().min(1).optional(),
  frames: FramePathSchema.default([]),
  landmarks: z.array(LandmarkSchema).min(1),
  minLandmarks: z.number().int().positive().optional(),
  negative: z.array(AssertionSchema).default([]),
});
export type ScreenSignature = z.infer<typeof ScreenSignatureSchema>;

/** Condition-based waits only; the single fixed sleep is the 150ms settle applied by the engine. */
export const WaitSchema = z.discriminatedUnion("for", [
  z.object({ for: z.literal("none") }),
  z.object({ for: z.literal("load"), timeoutMs: z.number().int().positive().default(8000) }),
  z.object({ for: z.literal("networkIdle"), timeoutMs: z.number().int().positive().default(8000) }),
  z.object({ for: z.literal("urlChange"), timeoutMs: z.number().int().positive().default(8000) }),
  z.object({ for: z.literal("landmark"), landmark: LandmarkSchema, frame: FramePathSchema.optional(), timeoutMs: z.number().int().positive().default(8000) }),
]);
export type Wait = z.infer<typeof WaitSchema>;

/** Detectors classify the current screen after each step; used by outcomes. */
export const DetectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("textMatches"), pattern: z.string().min(1), flags: regexFlags, frame: FramePathSchema.optional() }),
  z.object({ kind: z.literal("urlMatches"), pattern: z.string().min(1), flags: regexFlags, scope: z.enum(["frame", "top"]).default("frame") }),
  z.object({ kind: z.literal("dialogOpen"), messageMatches: z.string().optional(), dialogType: z.enum(["alert", "confirm", "prompt", "beforeunload"]).optional() }),
  z.object({ kind: z.literal("httpStatus"), min: z.number().int().min(100), max: z.number().int().max(599) }),
  z.object({ kind: z.literal("landmarkVisible"), landmark: LandmarkSchema, frame: FramePathSchema.optional() }),
]);
export type Detector = z.infer<typeof DetectorSchema>;

export const BBoxSchema = z.tuple([z.number(), z.number(), z.number().nonnegative(), z.number().nonnegative()]).describe("[x, y, width, height] in CSS pixels of the recorded viewport");
export type BBox = z.infer<typeof BBoxSchema>;

export const MoneySchema = z.object({ amount: z.number(), currency: z.string().length(3) });
export type Money = z.infer<typeof MoneySchema>;

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

import { z } from "zod";
import { CodeSchema, DetectorSchema, StepIdSchema } from "./common.js";

/**
 * The outcome catalog is the heart of the error contract:
 *  - business:    a legitimate result the caller needs ("no such member"). Replay stops, exit 0.
 *  - recoverable: a known condition with a fixed recovery, applied within limits, then continue.
 *  - failure:     stop with debuggable detail; optionally escalate to a human.
 */
export const OutcomeKindSchema = z.enum(["business", "recoverable", "failure"]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

export const RecoverySchema = z.union([
  z.string().regex(/^prelude:[a-z0-9][a-z0-9-]*$/).describe("Run a named prelude (e.g. prelude:login) then retry the current step."),
  z.enum(["dismissDialog", "retry", "reload"]),
]);
export type Recovery = z.infer<typeof RecoverySchema>;

export const OutcomeSchema = z
  .object({
    code: CodeSchema,
    kind: OutcomeKindSchema,
    message: z.string().min(1).describe("Human-readable meaning, returned to the caller for business outcomes."),
    detect: z.array(DetectorSchema).min(1).describe("All detectors must match."),
    appliesTo: z.union([z.literal("any"), z.array(StepIdSchema).min(1)]).default("any"),
    recover: RecoverySchema.optional(),
    maxRecoveries: z.number().int().positive().default(1),
    escalate: z.boolean().default(false),
  })
  .superRefine((o, ctx) => {
    if (o.kind === "recoverable" && !o.recover) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recover"], message: "recoverable outcomes need a recovery" });
    if (o.kind !== "recoverable" && o.recover) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recover"], message: "only recoverable outcomes declare a recovery" });
  });
export type Outcome = z.infer<typeof OutcomeSchema>;

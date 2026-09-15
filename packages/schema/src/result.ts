import { z } from "zod";
import { CodeSchema, IsoDateTimeSchema, StepIdSchema } from "./common.js";
import { ValueSchema } from "./common.js";

/**
 * Side-effect state travels with every result so a calling agent never retries a committed
 * transfer blindly:
 *  - none:      no pointOfNoReturn step was attempted
 *  - possible:  one was attempted and its checkpoint did not verify
 *  - committed: one was attempted and verified
 */
export const SideEffectsSchema = z.enum(["none", "possible", "committed"]);
export type SideEffects = z.infer<typeof SideEffectsSchema>;

export const DriftRecordSchema = z.object({
  stepId: StepIdSchema,
  primaryStrategy: z.string(),
  matchedStrategy: z.string(),
  candidateIndex: z.number().int().nonnegative(),
});

export const RecoveryRecordSchema = z.object({
  stepId: StepIdSchema,
  code: CodeSchema,
  recovery: z.string(),
  attempt: z.number().int().positive(),
});

const common = {
  runId: z.string().min(1),
  capabilityId: z.string().min(1),
  capabilityVersion: z.number().int().positive(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
  durationMs: z.number().int().nonnegative(),
  stepsRun: z.number().int().nonnegative(),
  sideEffects: SideEffectsSchema,
  drift: z.array(DriftRecordSchema).default([]),
  recoveries: z.array(RecoveryRecordSchema).default([]),
  evidenceDir: z.string().min(1),
};

/** Pre-flight and runtime failure codes. Kept as a closed list so callers can switch on them. */
export const FailureCodeSchema = z.enum([
  // pre-flight (no browser opened)
  "INVALID_ARTIFACT", "INVALID_INPUT", "MISSING_SECRET", "ARTIFACT_NOT_APPROVED", "POLICY_VIOLATION", "RUN_IN_PROGRESS",
  // runtime
  "WRONG_SCREEN", "LOCATOR_NOT_FOUND", "AMBIGUOUS_LOCATOR", "CHECKPOINT_FAILED", "FINAL_CHECKPOINT_FAILED",
  "EXTRACTION_FAILED", "UNKNOWN_DIALOG", "RECOVERY_LOOP", "UNSAFE_RESTART", "STEP_TIMEOUT", "RUN_TIMEOUT", "NAVIGATION_BLOCKED",
  "PAGE_SWITCH_BLOCKED", "SESSION_LOST", "CONTROL_VIOLATION", "CANCELLED", "SURFACE_ERROR",
]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

export const EscalationReasonSchema = z.enum([
  "RISKY_STEP_NEEDS_APPROVAL", "AGENT_GAVE_UP", "LOOP_DETECTED", "MAX_STEPS_REACHED", "UNKNOWN_STATE",
  "REPLAY_FAILURE", "OUTCOME_ESCALATE", "BUSINESS_OUTCOME_REVIEW", "INTERVENTION_TIMEOUT",
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), outputs: z.record(z.unknown()), ...common }),
  z.object({ status: z.literal("business_outcome"), code: CodeSchema, message: z.string(), atStep: StepIdSchema.optional(), outputs: z.record(z.unknown()).default({}), ...common }),
  z.object({
    status: z.literal("failure"),
    code: FailureCodeSchema,
    atStep: StepIdSchema.optional(),
    expected: z.string(),
    observed: z.string(),
    evidence: z.object({ screenshot: z.string().optional(), fullPage: z.string().optional(), a11y: z.string().optional(), text: z.string().optional(), trace: z.string().optional(), narrative: z.string().optional() }).default({}),
    ...common,
  }),
  z.object({ status: z.literal("escalated"), interventionId: z.string().min(1), reason: EscalationReasonSchema, atStep: StepIdSchema.optional(), detail: z.string(), ...common }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

/** Process exit codes: business outcomes are results, not errors. */
export const EXIT_CODES: Record<ReplayResult["status"], number> = { success: 0, business_outcome: 0, failure: 2, escalated: 3 };

export const UsageSchema = z.object({
  provider: z.string(),
  model: z.string(),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const DiscoveryResultSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["completed", "needsReview", "escalated", "gave_up", "failed"]),
  goal: z.string(),
  params: z.record(ValueSchema).default({}).describe("Redacted: literals are replaced by their param reference."),
  artifactPath: z.string().optional(),
  verification: ReplayResultSchema.optional(),
  stepsTaken: z.number().int().nonnegative(),
  prunedSteps: z.number().int().nonnegative().default(0),
  usage: UsageSchema,
  reason: z.string().optional(),
  evidenceDir: z.string(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
});
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

import { z } from "zod";
import { ActionTypeSchema } from "./step.js";

/** The artifact's own policy must be a subset of the global policy at replay time. */
export const ArtifactPolicySchema = z.object({
  allowedOrigins: z.array(z.string().url()).min(1),
  allowedActions: z.array(ActionTypeSchema).min(1),
  blockedUrlPatterns: z.array(z.string()).default([]),
});
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

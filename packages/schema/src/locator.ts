import { z } from "zod";
import { BBoxSchema, FramePathSchema } from "./common.js";

/**
 * Usage statistics are written only by the stability runner (never by unattended replay) so
 * an artifact stays a reviewed document rather than a self-modifying one.
 */
export const CandidateStatsSchema = z.object({
  attempts: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  lastHitAt: z.string().datetime({ offset: true }).optional(),
});

const base = {
  confidence: z.number().min(0).max(1).describe("Recorder's prior for this strategy's stability."),
  stats: CandidateStatsSchema.optional(),
};

/**
 * One way to find a control. Candidates are tried in order on replay; the resolver reports
 * which one matched so drift is visible. Strategies are surface-neutral except `css`, which a
 * desktop adapter simply never emits.
 */
export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1), name: z.string().min(1), exact: z.boolean().default(false), ...base }),
  z.object({ strategy: z.literal("label"), text: z.string().min(1), exact: z.boolean().default(false), ...base }).describe("Adjacent label text or <label>; legacy apps use table cells as labels."),
  z.object({ strategy: z.literal("text"), text: z.string().min(1), exact: z.boolean().default(true), ...base }),
  z.object({ strategy: z.literal("placeholder"), text: z.string().min(1), ...base }),
  z.object({ strategy: z.literal("css"), selector: z.string().min(1), ...base }).describe("Layout-bound fallback. Never uses ids (legacy apps have none)."),
  z.object({
    strategy: z.literal("visual"),
    bbox: BBoxSchema,
    viewport: z.tuple([z.number().positive(), z.number().positive()]),
    anchorText: z.string().optional().describe("Text that must still be visible within 150px for the visual candidate to be trusted."),
    phash: z.string().optional().describe("Perceptual hash of the anchor region for a soft match."),
    ...base,
  }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;
export type LocatorStrategy = LocatorCandidate["strategy"];

export const LocatorSchema = z.object({
  frame: FramePathSchema.default([]),
  candidates: z.array(LocatorCandidateSchema).min(1),
  rationale: z.string().min(1).describe("Why the primary strategy was chosen and what the fallbacks cover."),
  recordedBBox: BBoxSchema.optional().describe("Where the control was at discovery time; used to disambiguate multiple matches."),
});
export type Locator = z.infer<typeof LocatorSchema>;

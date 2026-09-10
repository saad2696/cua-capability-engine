import { z } from "zod";
import { StepIdSchema } from "./common.js";
import { LocatorSchema } from "./locator.js";

export const SensitivitySchema = z.enum(["none", "pii", "secret"]);

export const InputSpecSchema = z.object({
  type: z.enum(["string", "number", "boolean", "enum"]),
  description: z.string().min(1),
  required: z.boolean().default(true),
  pattern: z.string().optional().describe("Regex the value must match (strings)."),
  enum: z.array(z.string()).min(1).optional(),
  sensitivity: SensitivitySchema.default("pii").describe("Defaults to pii: in a bank, assume caller data is sensitive unless declared otherwise."),
  example: z.string().optional().describe("Synthetic example for docs and tests; never real data."),
});
export type InputSpec = z.infer<typeof InputSpecSchema>;

/** How to pull a value off the screen. Ordered fallbacks, like locators. */
export const ExtractionCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("locator"), locator: LocatorSchema }),
  z.object({ strategy: z.literal("cellRightOfLabel"), label: z.string().min(1), frame: z.array(z.string()).optional() }).describe("Legacy forms: value is the cell to the right of the label cell."),
  z.object({ strategy: z.literal("tableCell"), rowMatch: z.string().min(1), columnHeader: z.string().min(1), frame: z.array(z.string()).optional() }).describe("Legacy tables: find the row containing rowMatch, take the cell under columnHeader."),
  z.object({ strategy: z.literal("regexInRegion"), pattern: z.string().min(1), group: z.number().int().nonnegative().default(1), frame: z.array(z.string()).optional() }),
]);
export type ExtractionCandidate = z.infer<typeof ExtractionCandidateSchema>;

export const ParseSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string"), trim: z.boolean().default(true) }),
  z.object({ kind: z.literal("number"), locale: z.string().default("en-US") }),
  z.object({ kind: z.literal("money"), locale: z.string().default("en-US"), currency: z.string().length(3).default("USD") }),
  z.object({ kind: z.literal("boolean"), truthy: z.array(z.string()).default(["yes", "true", "active", "y"]) }),
  z.object({ kind: z.literal("date"), format: z.string().default("YYYY-MM-DD") }),
]);

export const OutputSpecSchema = z.object({
  type: z.enum(["string", "number", "money", "boolean", "date"]),
  description: z.string().min(1),
  from: StepIdSchema.describe("The extract step that produces this output."),
  required: z.boolean().default(true),
  extract: z.object({
    candidates: z.array(ExtractionCandidateSchema).min(1),
    parse: ParseSpecSchema,
    validate: z.object({ min: z.number().optional(), max: z.number().optional(), pattern: z.string().optional() }).optional(),
  }),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

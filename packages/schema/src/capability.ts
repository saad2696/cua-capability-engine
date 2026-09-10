import { z } from "zod";
import { AssertionSchema, IdSchema, IsoDateTimeSchema } from "./common.js";
import { InputSpecSchema, OutputSpecSchema } from "./contract.js";
import { OutcomeSchema } from "./outcome.js";
import { ArtifactPolicySchema } from "./policy.js";
import { StepSchema } from "./step.js";

export const SCHEMA_VERSION = "1.0" as const;

export const CapabilityStatusSchema = z.enum(["draft", "needsReview", "approved", "deprecated"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const SurfaceKindSchema = z.enum(["web", "desktop"]);

const SENSITIVE_FIELD = /password|passcode|ssn|social|pin\b|secret|token|cvv|card/i;

export const CapabilitySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    capability: z.object({
      id: IdSchema,
      version: z.number().int().positive(),
      status: CapabilityStatusSchema,
      name: z.string().min(1),
      description: z.string().min(1).describe("What the capability does, for both a human reviewer and a calling agent."),
      summary: z.array(z.string()).default([]).describe("Auto-generated plain-English step list."),
      app: z.object({
        vendor: IdSchema,
        variant: IdSchema.default("default").describe("Tenant/variant this was recorded on; overlays specialize it."),
        surface: SurfaceKindSchema,
        observedAppVersion: z.string().optional(),
      }),
      changelog: z.array(z.object({ version: z.number().int().positive(), date: IsoDateTimeSchema, author: z.string(), note: z.string() })).default([]),
    }),
    requires: z.object({
      surface: SurfaceKindSchema,
      secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]).describe("Environment secrets the run needs, by name only."),
    }),
    inputs: z.record(IdSchema.or(z.string().regex(/^[a-z][A-Za-z0-9]*$/)), InputSpecSchema).default({}),
    outputs: z.record(z.string().regex(/^[a-z][A-Za-z0-9]*$/), OutputSpecSchema).default({}),
    preconditions: z.array(z.object({ kind: z.literal("authenticated"), via: z.string().regex(/^prelude:[a-z0-9][a-z0-9-]*$/) })).default([]),
    preludes: z.record(IdSchema, z.array(StepSchema).min(1)).default({}),
    steps: z.array(StepSchema).min(1),
    checkpoint: z.array(AssertionSchema).min(1).describe("Success condition verified after the last step."),
    outcomes: z.array(OutcomeSchema).default([]),
    policy: ArtifactPolicySchema,
    quality: z
      .object({
        confidence: z.number().min(0).max(1),
        lastStabilityRunId: z.string().optional(),
        passRate: z.number().min(0).max(1).optional(),
        measuredAt: IsoDateTimeSchema.optional(),
      })
      .optional(),
    provenance: z.object({
      discoveredAt: IsoDateTimeSchema,
      provider: z.string().min(1),
      model: z.string().min(1),
      runId: z.string().min(1),
      redacted: z.literal(true).describe("Recorder asserts that no sensitive literal survived."),
      approvedBy: z.string().optional(),
      approvedAt: IsoDateTimeSchema.optional(),
    }),
  })
  .superRefine((cap, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    // unique step ids across steps and preludes
    const seen = new Map<string, string>();
    const all: { where: string; step: z.infer<typeof StepSchema> }[] = [];
    cap.steps.forEach((s, i) => all.push({ where: `steps.${i}`, step: s }));
    for (const [name, steps] of Object.entries(cap.preludes)) steps.forEach((s, i) => all.push({ where: `preludes.${name}.${i}`, step: s }));
    for (const { where, step } of all) {
      const prev = seen.get(step.id);
      if (prev) issue([where, "id"], `duplicate step id ${step.id} (also at ${prev})`);
      seen.set(step.id, where);
    }

    // value references resolve
    const inputNames = new Set(Object.keys(cap.inputs));
    const secretNames = new Set(cap.requires.secrets);
    for (const { where, step } of all) {
      const v = step.value;
      if (v?.kind === "param" && !inputNames.has(v.name)) issue([where, "value"], `unknown input parameter "${v.name}"`);
      if (v?.kind === "secret" && !secretNames.has(v.name)) issue([where, "value"], `secret "${v.name}" not declared in requires.secrets`);
      // no literal into a sensitive-looking field
      if (v?.kind === "literal" && step.action === "type") {
        const names = step.target?.candidates.map((c) => ("name" in c ? c.name : "text" in c ? c.text : "")) ?? [];
        if (names.some((n) => SENSITIVE_FIELD.test(n))) issue([where, "value"], "literal value typed into a sensitive field; use a secret or param reference");
      }
      if (v?.kind === "literal" && /^\d{9}$|^\d{3}-\d{2}-\d{4}$/.test(v.value)) issue([where, "value"], "literal looks like an SSN; use a param reference");
    }
    for (const a of cap.checkpoint) if (a.kind === "textVisible" && a.value?.kind === "param" && !inputNames.has(a.value.name)) issue(["checkpoint"], `unknown input parameter "${a.value.name}"`);

    // outputs point at extract steps that name them
    const byId = new Map(all.map(({ step }) => [step.id, step]));
    for (const [name, out] of Object.entries(cap.outputs)) {
      const s = byId.get(out.from);
      if (!s) issue(["outputs", name, "from"], `references unknown step ${out.from}`);
      else if (s.action !== "extract") issue(["outputs", name, "from"], `step ${out.from} is not an extract step`);
      else if (s.output !== name) issue(["outputs", name, "from"], `step ${out.from} extracts "${s.output}", not "${name}"`);
      if (out.type !== out.extract.parse.kind) issue(["outputs", name, "extract", "parse"], `parse kind must match output type "${out.type}"`);
    }
    for (const { where, step } of all) if (step.action === "extract" && step.output && !cap.outputs[step.output]) issue([where, "output"], `output "${step.output}" is not declared in outputs`);

    // recoveries and preconditions reference existing preludes
    const preludeRef = (ref: string) => ref.startsWith("prelude:") && !cap.preludes[ref.slice("prelude:".length)];
    cap.outcomes.forEach((o, i) => {
      if (typeof o.recover === "string" && preludeRef(o.recover)) issue(["outcomes", i, "recover"], `unknown ${o.recover}`);
      if (o.appliesTo !== "any") for (const id of o.appliesTo) if (!byId.has(id)) issue(["outcomes", i, "appliesTo"], `unknown step ${id}`);
    });
    cap.preconditions.forEach((p, i) => { if (preludeRef(p.via)) issue(["preconditions", i, "via"], `unknown ${p.via}`); });

    // outcome codes unique
    const codes = new Set<string>();
    cap.outcomes.forEach((o, i) => { if (codes.has(o.code)) issue(["outcomes", i, "code"], `duplicate outcome code ${o.code}`); codes.add(o.code); });

    // step actions within the artifact's own policy
    const allowed = new Set(cap.policy.allowedActions);
    for (const { where, step } of all) if (!allowed.has(step.action) && step.action !== "assert") issue([where, "action"], `action ${step.action} not in policy.allowedActions`);

    // approved artifacts must carry approval metadata
    if (cap.capability.status === "approved" && !(cap.provenance.approvedBy && cap.provenance.approvedAt)) issue(["provenance"], "approved artifacts need approvedBy and approvedAt");
  });

export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityInput = z.input<typeof CapabilitySchema>;

export function artifactFileName(cap: Pick<Capability, "capability">): string {
  return `${cap.capability.id}@${cap.capability.version}.json`;
}

/** Plain-English step list for reviewers; also stored as `capability.summary`. */
export function summarizeCapability(cap: Capability): string[] {
  const describeValue = (v: z.infer<typeof StepSchema>["value"]): string =>
    !v ? "" : v.kind === "param" ? `{${v.name}}` : v.kind === "secret" ? `<secret ${v.name}>` : JSON.stringify(v.value);
  const describeTarget = (s: z.infer<typeof StepSchema>): string => {
    const c = s.target?.candidates[0];
    if (!c) return "";
    if (c.strategy === "role") return `${c.role} "${c.name}"`;
    if (c.strategy === "label" || c.strategy === "text" || c.strategy === "placeholder") return `"${c.text}"`;
    if (c.strategy === "css") return c.selector;
    return `element at ${c.bbox.join(",")}`;
  };
  const line = (s: z.infer<typeof StepSchema>): string => {
    const risk = s.risk === "risky" ? " [RISKY]" : "";
    const ponr = s.pointOfNoReturn ? " [POINT OF NO RETURN]" : "";
    switch (s.action) {
      case "navigate": return `Go to ${describeValue(s.value)}${risk}`;
      case "click": return `Click ${describeTarget(s)}${risk}${ponr}`;
      case "type": return `Type ${describeValue(s.value)} into ${describeTarget(s)}${risk}`;
      case "select": return `Select ${describeValue(s.value)} in ${describeTarget(s)}${risk}`;
      case "press": return `Press ${describeValue(s.value)}${risk}${ponr}`;
      case "extract": return `Read "${s.output}" from ${describeTarget(s)}`;
      case "assert": return `Verify: ${s.intent}`;
      case "dismissDialog": return `Dismiss dialog`;
    }
  };
  const out: string[] = [];
  for (const [name, steps] of Object.entries(cap.preludes)) steps.forEach((s, i) => out.push(`[${name} ${i + 1}] ${line(s)}`));
  cap.steps.forEach((s, i) => out.push(`${i + 1}. ${line(s)}`));
  return out;
}

/**
 * The policy file: one declarative document that bounds what any run may do.
 *
 * Policy is data, not code, for two reasons. An operator who is not going to read TypeScript still
 * has to be able to answer "what is this thing allowed to touch?", and a reviewer has to be able to
 * diff that answer between releases. Everything the engine enforces at runtime is derived from this
 * object, so there is exactly one place to look and exactly one thing to review.
 *
 * Unknown keys are rejected rather than ignored. A typo in a security control that silently does
 * nothing is worse than a startup error: `blockedUrlPatters: ["/admin"]` would otherwise read as a
 * policy that blocks /admin while enforcing nothing at all.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A string that must compile as a regular expression. Validated at load, not at first use. */
const RegexString = z.string().refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid regular expression" },
);

const OriginString = z.string().refine(
  (s) => {
    try {
      return new URL(s).origin !== "null";
    } catch {
      return false;
    }
  },
  { message: "not an absolute http(s) origin, e.g. http://localhost:4100" },
);

export const RiskPolicySchema = z
  .object({
    /** Matched against the accessible name of the control being clicked. */
    irreversibleButtonText: z.array(z.string().min(1)),
    /** Matched against the URL an action navigates to or a form posts at. */
    irreversibleUrlPatterns: z.array(RegexString),
    /** Treat submitting a form as a side effect even when nothing else matches. */
    formSubmitIsRisky: z.boolean(),
    /** Enter inside a text field submits the surrounding form in most legacy UIs. */
    keyboardEnterOnFormIsRisky: z.boolean(),
  })
  .strict();

export const DiscoveryPolicySettingsSchema = z
  .object({
    /** What to do when the model proposes a risky action: ask a human, or refuse outright. */
    onRisky: z.enum(["escalate", "block"]),
  })
  .strict();

export const ReplayPolicySettingsSchema = z
  .object({
    requireApprovedArtifact: z.boolean(),
    riskyStepsRequire: z.enum(["approvedArtifact", "humanConfirm", "block"]),
    escalateOnFailure: z.boolean(),
  })
  .strict();

export const RedactionPolicySchema = z
  .object({
    /** Field names whose typed value must never be logged, whatever the artifact declares. */
    sensitiveInputPattern: z.array(RegexString),
    /** Sensitivity assumed for a capability parameter that does not declare one. */
    paramSensitivityDefault: z.enum(["none", "pii", "secret"]),
    /** Not implemented; see the limits section of the README. Must be false so the gap is explicit. */
    maskEvidenceScreenshots: z.literal(false),
    /** When false, typed text appears in events as its length only. */
    logTypedValues: z.boolean(),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    allowedOrigins: z.array(OriginString).min(1),
    /** Blocked even inside an allowed origin — the allowlist is necessary, not sufficient. */
    blockedUrlPatterns: z.array(RegexString),
    allowedActions: z.array(z.string().min(1)).min(1),
    maxSteps: z.number().int().positive().max(500),
    runTimeoutMs: z.number().int().positive(),
    risk: RiskPolicySchema,
    discovery: DiscoveryPolicySettingsSchema,
    replay: ReplayPolicySettingsSchema,
    redaction: RedactionPolicySchema,
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;
export type RedactionPolicy = z.infer<typeof RedactionPolicySchema>;

/**
 * The defaults are deliberately the strict end of every axis: one origin, approved artifacts only,
 * no typed values in logs. Loosening is a visible edit to a tracked file.
 */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  allowedOrigins: ["http://localhost:4100"],
  blockedUrlPatterns: ["/__faults", "/__reset", "/admin"],
  allowedActions: ["click", "type", "select", "press", "navigate", "extract", "assert_state", "dismiss_dialog", "done", "give_up"],
  maxSteps: 40,
  runTimeoutMs: 300_000,
  risk: {
    irreversibleButtonText: [
      "confirm",
      "submit",
      "open account",
      "transfer",
      "delete",
      "close account",
      "approve",
      "post",
      "pay",
      "send",
    ],
    irreversibleUrlPatterns: ["/confirm", "/submit", "/open", "/transfer", "/delete"],
    formSubmitIsRisky: true,
    keyboardEnterOnFormIsRisky: true,
  },
  discovery: { onRisky: "escalate" },
  replay: { requireApprovedArtifact: true, riskyStepsRequire: "approvedArtifact", escalateOnFailure: false },
  redaction: {
    sensitiveInputPattern: ["password", "passcode", "ssn", "social", "pin", "secret", "token", "cvv", "security code"],
    paramSensitivityDefault: "pii",
    maskEvidenceScreenshots: false,
    logTypedValues: false,
  },
};

export interface PolicyIssue {
  path: string;
  message: string;
}

export type PolicyLoadResult = { ok: true; policy: Policy; source: string } | { ok: false; issues: PolicyIssue[]; source: string };

/** Parse and validate an already-read document. Separated from IO so it is testable without a file. */
export function parsePolicy(doc: unknown, source = "<inline>"): PolicyLoadResult {
  const parsed = PolicySchema.safeParse(doc);
  if (parsed.success) return { ok: true, policy: parsed.data, source };
  return {
    ok: false,
    source,
    issues: parsed.error.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message })),
  };
}

/**
 * Load `policy.yaml`. A missing file is not an error: the built-in defaults apply and the source
 * says so, which keeps `cua replay` usable in a checkout with no configuration while still letting
 * `cua doctor` report exactly which policy is in force.
 */
export function loadPolicy(path: string): PolicyLoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, policy: DEFAULT_POLICY, source: "built-in defaults" };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { ok: false, source: path, issues: [{ path: "(root)", message: `YAML did not parse: ${(err as Error).message}` }] };
  }
  return parsePolicy(doc, path);
}

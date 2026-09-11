/**
 * Pre-flight: everything that can be checked before a browser is opened. Failing here is cheap
 * and yields a precise code the caller can act on.
 */
import { validateCapability, type Capability, type FailureCode, type Step } from "@cua/schema";

export interface PreflightOptions {
  params: Record<string, string>;
  secrets: Record<string, string>;
  /** Global policy the artifact's own policy must be a subset of. */
  globalAllowedOrigins?: string[];
  globalAllowedActions?: string[];
  requireApproved: boolean;
  allowDraft: boolean;
  /** Keys of runs currently executing, for the run lock. */
  running?: Set<string>;
}

export type PreflightResult = { ok: true; capability: Capability; lockKey: string } | { ok: false; code: FailureCode; expected: string; observed: string };

export function runLockKey(cap: Capability, params: Record<string, string>): string {
  return `${cap.capability.id}@${cap.capability.version}:${Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")}`;
}

function allSteps(cap: Capability): Step[] {
  return [...Object.values(cap.preludes).flat(), ...cap.steps];
}

export function preflight(input: unknown, opts: PreflightOptions): PreflightResult {
  const v = validateCapability(input);
  if (!v.ok) return { ok: false, code: "INVALID_ARTIFACT", expected: "artifact valid against schema", observed: v.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ") };
  const cap = v.value;

  if (cap.capability.status === "deprecated") return { ok: false, code: "INVALID_ARTIFACT", expected: "a non-deprecated artifact", observed: `status ${cap.capability.status}` };
  if (opts.requireApproved && cap.capability.status !== "approved" && !opts.allowDraft)
    return { ok: false, code: "ARTIFACT_NOT_APPROVED", expected: "status approved (or --allow-draft)", observed: `status ${cap.capability.status}` };

  // parameters
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const val = opts.params[name];
    if (val === undefined) {
      if (spec.required) return { ok: false, code: "INVALID_INPUT", expected: `parameter ${name} (${spec.type})`, observed: "missing" };
      continue;
    }
    if (spec.pattern && !new RegExp(spec.pattern).test(val)) return { ok: false, code: "INVALID_INPUT", expected: `${name} matching ${spec.pattern}`, observed: spec.sensitivity === "none" ? JSON.stringify(val) : `[${spec.sensitivity} value, ${val.length} chars]` };
    if (spec.enum && !spec.enum.includes(val)) return { ok: false, code: "INVALID_INPUT", expected: `${name} in ${spec.enum.join("|")}`, observed: "not in enum" };
    if (spec.type === "number" && !Number.isFinite(Number(val))) return { ok: false, code: "INVALID_INPUT", expected: `${name} numeric`, observed: "not a number" };
    if (spec.type === "boolean" && !/^(true|false)$/i.test(val)) return { ok: false, code: "INVALID_INPUT", expected: `${name} true|false`, observed: "not boolean" };
  }
  const unknown = Object.keys(opts.params).filter((k) => !(k in cap.inputs));
  if (unknown.length) return { ok: false, code: "INVALID_INPUT", expected: `only declared inputs (${Object.keys(cap.inputs).join(", ") || "none"})`, observed: `unknown: ${unknown.join(", ")}` };

  // secrets
  for (const name of cap.requires.secrets) if (!(name in opts.secrets)) return { ok: false, code: "MISSING_SECRET", expected: `secret ${name} in environment`, observed: "missing" };

  // policy subset
  if (opts.globalAllowedOrigins) {
    const global = new Set(opts.globalAllowedOrigins.map((o) => new URL(o).origin));
    const bad = cap.policy.allowedOrigins.map((o) => new URL(o).origin).filter((o) => !global.has(o));
    if (bad.length) return { ok: false, code: "POLICY_VIOLATION", expected: `artifact origins within ${[...global].join(", ")}`, observed: `not allowed: ${bad.join(", ")}` };
  }
  if (opts.globalAllowedActions) {
    const global = new Set(opts.globalAllowedActions);
    const bad = allSteps(cap).map((s) => s.action).filter((a) => a !== "assert" && !global.has(a));
    if (bad.length) return { ok: false, code: "POLICY_VIOLATION", expected: `actions within ${[...global].join(", ")}`, observed: `not allowed: ${[...new Set(bad)].join(", ")}` };
  }

  const lockKey = runLockKey(cap, opts.params);
  if (opts.running?.has(lockKey)) return { ok: false, code: "RUN_IN_PROGRESS", expected: "no concurrent replay of the same capability and parameters", observed: `running: ${cap.capability.id}` };

  return { ok: true, capability: cap, lockKey };
}

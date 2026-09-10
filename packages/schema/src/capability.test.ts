import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  artifactFileName, CapabilitySchema, DEFAULT_RETRYABLE, EXIT_CODES, isRetryable, migrateCapability,
  parseCapability, ReplayResultSchema, StepSchema, summarizeCapability, UnsupportedSchemaVersionError, validateCapability,
  type CapabilityInput,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = resolve(here, "../../../artifacts/examples/member-savings-balance@1.json");
const example = (): CapabilityInput => JSON.parse(readFileSync(examplePath, "utf8")) as CapabilityInput;

const paths = (r: ReturnType<typeof validateCapability>) => (r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`));

describe("example artifact", () => {
  it("validates", () => {
    const r = validateCapability(example());
    expect(paths(r)).toEqual([]);
    expect(r.ok && r.value.capability.id).toBe("member-savings-balance");
  });
  it("names its file id@version.json", () => {
    expect(artifactFileName(parseCapability(example()))).toBe("member-savings-balance@1.json");
  });
  it("summarizes to plain English without leaking values", () => {
    const lines = summarizeCapability(parseCapability(example()));
    expect(lines[0]).toBe('[login 1] Go to "http://localhost:4100/"');
    expect(lines).toContain('[login 3] Type <secret TARGET_PASSWORD> into textbox "Password"');
    expect(lines).toContain('1. Type {memberId} into textbox "Member ID"');
    expect(lines.at(-1)).toContain('Read "savingsBalance"');
  });
  it("applies defaults (retryable per action, risk safe, wait load)", () => {
    const cap = parseCapability(example());
    const search = cap.steps.find((s) => s.id === "step:search")!;
    expect(search.risk).toBe("safe");
    expect(isRetryable(search)).toBe(false); // explicitly false in example
    const type = cap.steps.find((s) => s.id === "step:enter-member-id")!;
    expect(isRetryable(type)).toBe(true); // default for type
    expect(DEFAULT_RETRYABLE.click).toBe(false);
  });
});

describe("cross-field validation", () => {
  it("rejects a missing checkpoint", () => {
    const cap = example();
    cap.checkpoint = [];
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("checkpoint"));
  });
  it("rejects an unknown param reference", () => {
    const cap = example();
    cap.steps[0]!.value = { kind: "param", name: "accountNumber" };
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining('unknown input parameter "accountNumber"'));
  });
  it("rejects an undeclared secret", () => {
    const cap = example();
    cap.requires.secrets = ["TARGET_USER"];
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining('secret "TARGET_PASSWORD" not declared'));
  });
  it("rejects a literal typed into a sensitive field", () => {
    const cap = example();
    cap.preludes!.login![2]!.value = { kind: "literal", value: "hunter2" };
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("sensitive field"));
  });
  it("rejects a literal that looks like an SSN", () => {
    const cap = example();
    cap.steps[0]!.value = { kind: "literal", value: "123-45-6789" };
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("looks like an SSN"));
  });
  it("rejects outputs that point at the wrong step", () => {
    const cap = example();
    cap.outputs!.savingsBalance!.from = "step:search";
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("is not an extract step"));
  });
  it("rejects parse kind mismatching output type", () => {
    const cap = example();
    cap.outputs!.savingsBalance!.extract.parse = { kind: "string" };
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("parse kind must match"));
  });
  it("rejects duplicate step ids across preludes and steps", () => {
    const cap = example();
    cap.steps[1]!.id = "step:login-submit";
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("duplicate step id"));
  });
  it("rejects recoveries that reference unknown preludes", () => {
    const cap = example();
    cap.outcomes![3]!.recover = "prelude:relogin";
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("unknown prelude:relogin"));
  });
  it("rejects business outcomes with a recovery and recoverable ones without", () => {
    const cap = example();
    cap.outcomes![0]!.recover = "retry";
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("only recoverable outcomes declare a recovery"));
    const cap2 = example();
    delete cap2.outcomes![3]!.recover;
    expect(paths(validateCapability(cap2))).toContainEqual(expect.stringContaining("recoverable outcomes need a recovery"));
  });
  it("rejects actions outside the artifact's own policy", () => {
    const cap = example();
    cap.policy.allowedActions = ["click", "type", "extract"]; // navigate removed
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("action navigate not in policy"));
  });
  it("requires approval metadata on approved artifacts", () => {
    const cap = example();
    cap.capability.status = "approved";
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("approvedBy"));
    cap.provenance.approvedBy = "reviewer";
    cap.provenance.approvedAt = "2026-09-10T00:00:00Z";
    expect(validateCapability(cap).ok).toBe(true);
  });
  it("rejects pointOfNoReturn on a safe step and optional steps that fail", () => {
    const base = { id: "step:x", intent: "x", action: "click" as const, target: { candidates: [{ strategy: "text" as const, text: "Go", confidence: 0.5 }], rationale: "r" } };
    expect(StepSchema.safeParse({ ...base, pointOfNoReturn: true }).success).toBe(false);
    expect(StepSchema.safeParse({ ...base, pointOfNoReturn: true, risk: "risky" }).success).toBe(true);
    expect(StepSchema.safeParse({ ...base, optional: true }).success).toBe(false);
    expect(StepSchema.safeParse({ ...base, optional: true, onFailure: "skipIfOptional" }).success).toBe(true);
  });
  it("requires target/value/output per action", () => {
    expect(StepSchema.safeParse({ id: "step:a", intent: "i", action: "click" }).success).toBe(false);
    expect(StepSchema.safeParse({ id: "step:a", intent: "i", action: "press" }).success).toBe(false);
    expect(StepSchema.safeParse({ id: "step:a", intent: "i", action: "press", value: { kind: "literal", value: "Enter" } }).success).toBe(true);
    expect(StepSchema.safeParse({ id: "step:a", intent: "i", action: "navigate", value: { kind: "secret", name: "URL" } }).success).toBe(false);
  });
  it("textVisible needs exactly one of pattern or value", () => {
    const cap = example();
    cap.checkpoint = [{ kind: "textVisible" }];
    expect(paths(validateCapability(cap))).toContainEqual(expect.stringContaining("exactly one of pattern or value"));
  });
});

describe("migration", () => {
  it("passes current version through untouched", () => {
    const { migrated } = migrateCapability(example());
    expect(migrated).toEqual([]);
  });
  it("reports unsupported versions as an issue, not a throw", () => {
    const cap = example() as Record<string, unknown>;
    cap["schemaVersion"] = "0.9";
    const r = validateCapability(cap);
    expect(paths(r)[0]).toContain("unsupported schemaVersion \"0.9\"");
    expect(() => migrateCapability(cap)).toThrow(UnsupportedSchemaVersionError);
  });
});

describe("result contract", () => {
  const common = {
    runId: "r1", capabilityId: "member-savings-balance", capabilityVersion: 1, startedAt: "2026-09-10T00:00:00Z", finishedAt: "2026-09-10T00:00:05Z",
    durationMs: 5000, stepsRun: 3, sideEffects: "none", evidenceDir: "evidence/replay-r1",
  } as const;
  it("accepts each status and maps exit codes", () => {
    expect(ReplayResultSchema.safeParse({ status: "success", outputs: { savingsBalance: { amount: 1234.56, currency: "USD" } }, ...common }).success).toBe(true);
    expect(ReplayResultSchema.safeParse({ status: "business_outcome", code: "MEMBER_NOT_FOUND", message: "no such member", atStep: "step:search", ...common }).success).toBe(true);
    expect(ReplayResultSchema.safeParse({ status: "failure", code: "WRONG_SCREEN", atStep: "step:search", expected: "cell Member Detail", observed: "cell Sign In", ...common }).success).toBe(true);
    expect(ReplayResultSchema.safeParse({ status: "escalated", interventionId: "i1", reason: "RISKY_STEP_NEEDS_APPROVAL", detail: "confirm", ...common }).success).toBe(true);
    expect(EXIT_CODES).toEqual({ success: 0, business_outcome: 0, failure: 2, escalated: 3 });
  });
  it("rejects unknown failure codes", () => {
    expect(ReplayResultSchema.safeParse({ status: "failure", code: "SOMETHING_ELSE", expected: "", observed: "", ...common }).success).toBe(false);
  });
});

describe("full-schema parse of example equals validate", () => {
  it("CapabilitySchema.parse works directly", () => {
    expect(() => CapabilitySchema.parse(example())).not.toThrow();
  });
});

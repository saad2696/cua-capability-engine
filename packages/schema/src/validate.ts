import type { ZodError } from "zod";
import { CapabilitySchema, type Capability } from "./capability.js";
import { migrateCapability, UnsupportedSchemaVersionError } from "./migrate/index.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: Capability; migrated: string[] }
  | { ok: false; issues: ValidationIssue[] };

export function formatIssues(err: ZodError): ValidationIssue[] {
  return err.issues.map((i) => ({ path: i.path.length ? i.path.join(".") : "(root)", message: i.message }));
}

/** Migrate then validate. Never throws for bad input; returns a list of issues with JSON paths. */
export function validateCapability(input: unknown): ValidationResult {
  let raw: unknown;
  let migrated: string[];
  try {
    ({ raw, migrated } = migrateCapability(input));
  } catch (e) {
    if (e instanceof UnsupportedSchemaVersionError) return { ok: false, issues: [{ path: "schemaVersion", message: e.message }] };
    throw e;
  }
  const parsed = CapabilitySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  return { ok: true, value: parsed.data, migrated };
}

/** Throwing variant for code paths that already trust the input. */
export function parseCapability(input: unknown): Capability {
  const r = validateCapability(input);
  if (!r.ok) throw new Error(`invalid capability:\n${r.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  return r.value;
}

/**
 * Schema migrations. Each entry upgrades a raw artifact from one schemaVersion to the next.
 * `migrateCapability` walks the chain until the current version and returns the raw object,
 * which the caller then validates with CapabilitySchema.
 */
import { SCHEMA_VERSION } from "../capability.js";

type Raw = Record<string, unknown> & { schemaVersion?: unknown };
type Migration = { from: string; to: string; apply: (raw: Raw) => Raw };

/** Ordered chain. 1.0 is the first version, so the chain is empty today; the scaffold is tested. */
export const MIGRATIONS: Migration[] = [];

export class UnsupportedSchemaVersionError extends Error {
  constructor(public readonly version: unknown) {
    super(`unsupported schemaVersion ${JSON.stringify(version)}; supported: ${[...MIGRATIONS.map((m) => m.from), SCHEMA_VERSION].join(", ")}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export function migrateCapability(input: unknown): { raw: Raw; migrated: string[] } {
  if (typeof input !== "object" || input === null) throw new UnsupportedSchemaVersionError(undefined);
  let raw = input as Raw;
  const applied: string[] = [];
  for (let guard = 0; guard < 32; guard += 1) {
    if (raw.schemaVersion === SCHEMA_VERSION) return { raw, migrated: applied };
    const m = MIGRATIONS.find((x) => x.from === raw.schemaVersion);
    if (!m) throw new UnsupportedSchemaVersionError(raw.schemaVersion);
    raw = { ...m.apply(raw), schemaVersion: m.to };
    applied.push(`${m.from}->${m.to}`);
  }
  throw new Error("migration chain did not converge");
}

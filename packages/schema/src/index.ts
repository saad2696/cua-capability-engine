/**
 * @cua/schema — contracts shared by the engine, CLI, console, and external agents.
 *
 * Slice 003 fills this package with the Capability artifact schema, the ReplayResult
 * contract, and evidence event types. Until then it exposes only the schema version.
 */
export const SCHEMA_VERSION = "1.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

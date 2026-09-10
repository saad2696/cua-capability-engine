/**
 * cua artifact validate <file>   — migrate + validate, print issues with JSON paths (exit 1 on failure)
 * cua artifact summary  <file>   — print the contract and plain-English step list for review
 */
import { readFileSync } from "node:fs";
import { summarizeCapability, validateCapability, type Capability } from "@cua/schema";

function load(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}

export function artifactCommand(argv: string[]): void {
  const [sub, file] = argv;
  if (!sub || !file || !["validate", "summary"].includes(sub)) {
    console.error("usage: cua artifact <validate|summary> <file.json>");
    process.exitCode = 1;
    return;
  }
  const result = validateCapability(load(file));
  if (!result.ok) {
    console.error(`INVALID ${file}`);
    for (const i of result.issues) console.error(`  ${i.path}: ${i.message}`);
    process.exitCode = 1;
    return;
  }
  const cap: Capability = result.value;
  if (sub === "validate") {
    console.log(`OK ${file}`);
    console.log(`  ${cap.capability.id}@${cap.capability.version} (${cap.capability.status}) schema ${cap.schemaVersion}${result.migrated.length ? ` migrated ${result.migrated.join(", ")}` : ""}`);
    console.log(`  steps ${cap.steps.length}, preludes ${Object.keys(cap.preludes).length}, outcomes ${cap.outcomes.length}, risky steps ${cap.steps.filter((s) => s.risk === "risky").length}`);
    return;
  }
  console.log(`${cap.capability.name}  [${cap.capability.id}@${cap.capability.version}, ${cap.capability.status}]`);
  console.log(cap.capability.description);
  console.log(`\nApp: ${cap.capability.app.vendor} / ${cap.capability.app.variant} (${cap.capability.app.surface})`);
  console.log(`Requires secrets: ${cap.requires.secrets.join(", ") || "none"}`);
  console.log("\nInputs:");
  for (const [k, v] of Object.entries(cap.inputs)) console.log(`  ${k}: ${v.type}${v.required ? "" : "?"}  (${v.sensitivity})  ${v.description}`);
  console.log("Outputs:");
  for (const [k, v] of Object.entries(cap.outputs)) console.log(`  ${k}: ${v.type}  from ${v.from}  ${v.description}`);
  console.log("\nSteps:");
  for (const line of summarizeCapability(cap)) console.log(`  ${line}`);
  console.log("\nCheckpoint:");
  for (const a of cap.checkpoint) console.log(`  ${JSON.stringify(a)}`);
  console.log("\nOutcomes:");
  for (const o of cap.outcomes) console.log(`  ${o.code.padEnd(20)} ${o.kind.padEnd(12)} ${o.recover ? `recover=${o.recover} ` : ""}${o.escalate ? "escalate " : ""}${o.message}`);
  console.log(`\nPolicy: origins ${cap.policy.allowedOrigins.join(", ")}; actions ${cap.policy.allowedActions.join(", ")}`);
}

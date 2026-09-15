/**
 * cua replay <artifact.json> [--param k=v ...] [--plan] [--allow-draft] [--headed]
 *            [--fault <name>[:sticky]] [--escalate-on-failure] [--escalate-on-outcome] [--evidence-name <dir>] [--json]
 *
 * Deterministic replay: no model in the loop. Exit codes: success 0, business_outcome 0,
 * failure 2, escalated 3.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EvidenceWriter, PlaywrightSurface, PolicyEnforcedSurface, Redactor, newRunId, planLines, replay, runPolicy } from "@cua/engine";
import { EXIT_CODES, validateCapability, type ReplayResult } from "@cua/schema";

const SECRET_ENV = ["TARGET_USER", "TARGET_PASSWORD"];

export async function replayCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      param: { type: "string", multiple: true, default: [] }, plan: { type: "boolean", default: false }, "allow-draft": { type: "boolean", default: false },
      headed: { type: "boolean", default: false }, fault: { type: "string" }, "escalate-on-failure": { type: "boolean", default: false }, "escalate-on-outcome": { type: "boolean", default: false },
      "evidence-name": { type: "string" }, json: { type: "boolean", default: false }, "risky": { type: "string" },
      "resume-from": { type: "string" }, "timeout": { type: "string" },
    },
  });
  const file = positionals[0];
  if (!file) {
    console.error("usage: cua replay <artifact.json> [--param k=v] [--plan] [--allow-draft] [--fault not_found] [--headed] [--resume-from <n>] [--timeout <ms>]");
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const params: Record<string, string> = {};
  for (const p of values.param) {
    const [k, ...rest] = p.split("=");
    if (k && rest.length) params[k] = rest.join("=");
  }
  const secrets: Record<string, string> = {};
  for (const name of SECRET_ENV) if (process.env[name]) secrets[name] = process.env[name]!;

  if (values.plan) {
    const v = validateCapability(raw);
    if (!v.ok) {
      console.error(`INVALID ${file}`);
      for (const i of v.issues) console.error(`  ${i.path}: ${i.message}`);
      process.exitCode = 2;
      return;
    }
    for (const line of planLines(v.value)) console.log(line);
    return;
  }

  const runId = newRunId("replay");
  const redactor = new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } });
  const evidence = new EvidenceWriter(runId, process.env["CUA_EVIDENCE_DIR"] ?? "evidence", redactor, values["evidence-name"] ?? runId);
  const origins = (raw as { policy?: { allowedOrigins?: string[] } }).policy?.allowedOrigins ?? [];
  // policy.yaml supplies every rule; the artifact supplies only which origin this capability runs
  // against, which the file cannot know.
  const { gate: policy, policy: doc, source: policySource } = runPolicy({ origins: origins.length ? origins : ["http://localhost:4100"] });
  if (!values.json) console.log(`  policy: ${policySource}`);
  const surface = new PlaywrightSurface({ headless: !values.headed, allowRequest: (u) => policy.allowRequest(u), tracePath: join(evidence.dir, "trace.zip") });
  surface.onPageSwitch((u) => (policy.allowRequest(u) ? "adopt" : "close"));
  // Enforcement layer 2: the allowlist is re-checked where the action becomes real, so a replay
  // driven straight from the CLI — with no model and no session in the loop — passes the same gate.
  const guarded = new PolicyEnforcedSurface(surface, {
    gate: policy,
    onBlock: (action, reason) => evidence.event({ type: "policy_block", action, reason, controller: "replay" }),
  });

  const cookies: { url: string; name: string; value: string }[] = [];
  if (values.fault) {
    const [fault, mode] = values.fault.split(":");
    const url = origins[0] ?? "http://localhost:4100";
    cookies.push({ url, name: "cu_fault", value: fault! });
    if (mode === "sticky") cookies.push({ url, name: "cu_fault_sticky", value: "1" });
  }

  let result: ReplayResult;
  try {
    result = await replay({
      artifact: raw, params, secrets, surface: guarded, evidence,
      globalPolicy: { allowedOrigins: policy.allowedOrigins },
      allowDraft: values["allow-draft"] || !doc.replay.requireApprovedArtifact, riskyStepsRequire: (values.risky as "approvedArtifact" | "humanConfirm" | "block" | undefined) ?? doc.replay.riskyStepsRequire,
      escalateOnFailure: values["escalate-on-failure"] || doc.replay.escalateOnFailure,
      escalateOnBusinessOutcome: values["escalate-on-outcome"], cookies,
      ...(values["resume-from"] ? { startAtStepIndex: Number(values["resume-from"]) } : {}),
      runTimeoutMs: values.timeout ? Number(values.timeout) : doc.runTimeoutMs,
      log: (line) => { if (!values.json) console.log(`  ${line}`); },
    });
  } finally {
    await surface.close();
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`  → ${result.status.toUpperCase()}${"code" in result ? ` ${result.code}` : ""}${"reason" in result ? ` ${result.reason}` : ""}  (${result.stepsRun} steps, ${result.durationMs}ms, side effects: ${result.sideEffects})`);
    if (result.status === "success") console.log(`  outputs: ${JSON.stringify(result.outputs)}`);
    if (result.status === "business_outcome") console.log(`  ${result.message}`);
    if (result.status === "failure") console.log(`  at ${result.atStep ?? "run"}: expected ${result.expected}; observed ${result.observed}\n  narrative: ${result.evidence.narrative ?? "-"}`);
    if (result.status === "escalated") console.log(`  ${result.detail} (intervention ${result.interventionId})`);
    if (result.drift.length) console.log(`  drift: ${result.drift.map((d) => `${d.stepId} ${d.primaryStrategy}→${d.matchedStrategy}`).join(", ")}`);
    if (result.recoveries.length) console.log(`  recoveries: ${result.recoveries.map((r) => `${r.code} via ${r.recovery}`).join(", ")}`);
    console.log(`  evidence: ${result.evidenceDir}`);
  }
  process.exitCode = EXIT_CODES[result.status];
}

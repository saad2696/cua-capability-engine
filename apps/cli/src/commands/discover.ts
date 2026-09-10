/**
 * cua discover --goal "..." --url <url> --capability-id <id> [--param k=v ...]
 *              [--provider anthropic|fake] [--model id] [--max-steps n] [--headed]
 *              [--approve-risky] [--vendor legacy-cu-core] [--out <artifacts dir>]
 *
 * Runs the LLM-driven discovery loop against the live surface, records the successful run as
 * a capability artifact, and writes evidence for the run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AnthropicProvider, EvidenceWriter, FakeProvider, PlaywrightSurface, Redactor, basicPolicy, estimateCostUsd, newRunId,
  recordCapability, runDiscovery, type LlmProvider, type ScriptStep,
} from "@cua/engine";
import { artifactFileName, DiscoveryResultSchema, summarizeCapability, type Outcome } from "@cua/schema";

const SECRET_ENV = ["TARGET_USER", "TARGET_PASSWORD"];

export async function discoverCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      goal: { type: "string" }, url: { type: "string" }, "capability-id": { type: "string" }, name: { type: "string" },
      param: { type: "string", multiple: true, default: [] }, provider: { type: "string", default: process.env["ANTHROPIC_API_KEY"] ? "anthropic" : "fake" },
      model: { type: "string" }, "max-steps": { type: "string", default: "30" }, headed: { type: "boolean", default: false },
      "approve-risky": { type: "boolean", default: false }, vendor: { type: "string", default: "legacy-cu-core" },
      out: { type: "string", default: "artifacts" }, "fake-script": { type: "string" }, "evidence-name": { type: "string" },
    },
  });
  const goal = values.goal;
  const url = values.url ?? process.env["TARGET_APP_URL"];
  const capabilityId = values["capability-id"];
  if (!goal || !url || !capabilityId) {
    console.error('usage: cua discover --goal "..." --url <url> --capability-id <kebab-id> [--param memberId=10042] [--provider anthropic|fake]');
    process.exitCode = 1;
    return;
  }
  const params: Record<string, string> = {};
  for (const p of values.param) {
    const [k, ...rest] = p.split("=");
    if (k && rest.length) params[k] = rest.join("=");
  }
  const secrets: Record<string, string> = {};
  for (const name of SECRET_ENV) if (process.env[name]) secrets[name] = process.env[name]!;

  let provider: LlmProvider;
  if (values.provider === "fake") {
    if (!values["fake-script"]) {
      console.error("--provider fake needs --fake-script <file.mjs> exporting `script: ScriptStep[]`");
      process.exitCode = 1;
      return;
    }
    const mod = (await import(new URL(values["fake-script"], `file://${process.cwd()}/`).href)) as { script: ScriptStep[] };
    provider = new FakeProvider(mod.script);
  } else {
    provider = new AnthropicProvider({ ...(values.model ? { model: values.model } : {}) });
  }

  const origin = new URL(url).origin;
  const policy = basicPolicy({ allowedOrigins: [origin], blockedUrlPatterns: ["/__faults", "/__reset"] });
  const runId = newRunId("discover");
  const redactor = new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } });
  const evidence = new EvidenceWriter(runId, process.env["CUA_EVIDENCE_DIR"] ?? "evidence", redactor, values["evidence-name"] ?? runId);
  const surface = new PlaywrightSurface({ headless: !values.headed, allowRequest: (u) => policy.allowRequest(u) });
  surface.onPageSwitch((u) => (policy.allowRequest(u) ? "adopt" : "close"));

  console.log(`discover ${capabilityId}  provider=${provider.name}/${provider.model}  evidence=${evidence.dir}`);
  const started = Date.now();
  try {
    const trace = await runDiscovery({
      goal, url, params, secrets, provider, surface, policy, evidence, maxSteps: Number(values["max-steps"]),
      ...(values["approve-risky"] ? { approveRisky: async () => true } : {}),
      log: (line) => console.log(`  ${line}`),
    });
    evidence.json("trace.json", { ...trace, steps: trace.steps.map((s) => ({ ...s, before: { ...s.before, text: undefined }, after: s.after ? { ...s.after, text: undefined } : undefined })) });

    const usage = { provider: provider.name, model: provider.model, calls: trace.usage.calls, inputTokens: trace.usage.inputTokens, outputTokens: trace.usage.outputTokens, ...(estimateCostUsd(provider.model, trace.usage.inputTokens, trace.usage.outputTokens) !== undefined ? { estimatedCostUsd: estimateCostUsd(provider.model, trace.usage.inputTokens, trace.usage.outputTokens)! } : {}) };
    evidence.json("usage.json", usage, false);

    let artifactPath: string | undefined;
    let prunedSteps = 0;
    let status: "completed" | "needsReview" | "escalated" | "gave_up" | "failed" = trace.status;
    if (trace.status === "completed") {
      const defaultsPath = join("artifacts", "defaults", `${values.vendor}.outcomes.json`);
      const defaultOutcomes = existsSync(defaultsPath) ? (JSON.parse(readFileSync(defaultsPath, "utf8")) as Outcome[]) : [];
      const rec = recordCapability(trace, secrets, {
        capabilityId, name: values.name ?? goal, vendor: values.vendor, allowedOrigins: [origin], defaultOutcomes,
        provider: provider.name, model: provider.model,
      });
      rec.capability.capability.summary = summarizeCapability(rec.capability);
      if (rec.warnings.length) {
        rec.capability.capability.status = "needsReview";
        status = "needsReview";
      }
      prunedSteps = rec.prunedStepIds.length;
      if (rec.prunedStepIds.length) evidence.event({ type: "pruned", removedStepIds: rec.prunedStepIds, reason: "detour or no-op" });
      mkdirSync(values.out, { recursive: true });
      artifactPath = join(values.out, artifactFileName(rec.capability));
      writeFileSync(artifactPath, JSON.stringify(rec.capability, null, 2) + "\n");
      evidence.json("artifact.json", rec.capability, false);
      for (const w of rec.warnings) console.warn(`  warning: ${w}`);
      console.log(`  artifact: ${artifactPath} (${rec.capability.capability.status}; ${rec.capability.steps.length} steps, ${Object.keys(rec.capability.preludes).length} prelude(s), ${rec.prunedStepIds.length} pruned)`);
      for (const line of rec.capability.capability.summary) console.log(`    ${line}`);
    }
    const result = DiscoveryResultSchema.parse({
      runId, status, goal, params: Object.fromEntries(Object.keys(params).map((k) => [k, { kind: "param", name: k }])),
      ...(artifactPath ? { artifactPath } : {}), stepsTaken: trace.steps.length, prunedSteps, usage,
      ...(trace.reason ? { reason: trace.reason } : {}), evidenceDir: evidence.dir, startedAt: trace.startedAt, finishedAt: trace.finishedAt,
    });
    evidence.json("run.json", result);
    console.log(`  ${status}${trace.reason ? ` (${trace.reason})` : ""} in ${Math.round((Date.now() - started) / 1000)}s; ${usage.calls} model calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens${usage.estimatedCostUsd !== undefined ? ` (~$${usage.estimatedCostUsd.toFixed(3)})` : ""}`);
    process.exitCode = status === "completed" || status === "needsReview" ? 0 : status === "escalated" ? 3 : 2;
  } finally {
    await surface.close();
  }
}

/**
 * cua discover --goal "..." --url <url> --capability-id <id> [--param k=v ...]
 *              [--provider anthropic|fake] [--model id] [--max-steps n] [--headed]
 *              --max-steps defaults to policy.yaml's maxSteps (40).
 *              [--approve-risky] [--vendor legacy-cu-core] [--out <artifacts dir>]
 *
 * Runs the LLM-driven discovery loop against the live surface, records the successful run as
 * a capability artifact, and writes evidence for the run.
 */
import { parseArgs } from "node:util";
import {
  AnthropicProvider, EvidenceWriter, FakeProvider, PlaywrightSurface, PolicyEnforcedSurface, runPolicy, Redactor, newRunId,
  finishDiscovery, runDiscovery, type LlmProvider, type ScriptStep,
} from "@cua/engine";


const SECRET_ENV = ["TARGET_USER", "TARGET_PASSWORD"];

export async function discoverCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      goal: { type: "string" }, url: { type: "string" }, "capability-id": { type: "string" }, name: { type: "string" },
      param: { type: "string", multiple: true, default: [] }, provider: { type: "string", default: process.env["ANTHROPIC_API_KEY"] ? "anthropic" : "fake" },
      model: { type: "string" }, "max-steps": { type: "string" }, headed: { type: "boolean", default: false },
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
  const { gate: policy, policy: doc, source: policySource } = runPolicy({ origins: [origin] });
  const runId = newRunId("discover");
  const redactor = new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } });
  const evidence = new EvidenceWriter(runId, process.env["CUA_EVIDENCE_DIR"] ?? "evidence", redactor, values["evidence-name"] ?? runId);
  const surface = new PlaywrightSurface({ headless: !values.headed, allowRequest: (u) => policy.allowRequest(u) });
  surface.onPageSwitch((u) => (policy.allowRequest(u) ? "adopt" : "close"));
  // Enforcement layer 2: the model's decisions are already checked, but an action that reaches the
  // surface by any other route is checked here too.
  const guarded = new PolicyEnforcedSurface(surface, {
    gate: policy,
    onBlock: (action, reason) => evidence.event({ type: "policy_block", action, reason, controller: "agent" }),
  });

  console.log(`  policy: ${policySource}`);
  console.log(`discover ${capabilityId}  provider=${provider.name}/${provider.model}  evidence=${evidence.dir}`);
  const started = Date.now();
  try {
    const trace = await runDiscovery({
      goal, url, params, secrets, provider, surface: guarded, policy, evidence, maxSteps: values["max-steps"] ? Number(values["max-steps"]) : doc.maxSteps,
      ...(values["approve-risky"] ? { approveRisky: async () => true } : {}),
      log: (line) => console.log(`  ${line}`),
    });
    evidence.json("trace.json", { ...trace, steps: trace.steps.map((s) => ({ ...s, before: { ...s.before, text: undefined }, after: s.after ? { ...s.after, text: undefined } : undefined })) });

    const fin = finishDiscovery({
      runId, trace, secrets, evidence, capabilityId, ...(values.name ? { name: values.name } : {}),
      vendor: values.vendor, origin, provider: provider.name, model: provider.model, outDir: values.out,
    });
    const { result, warnings, artifactPath } = fin;
    const status = result.status;
    for (const w of warnings) console.warn(`  warning: ${w}`);
    if (fin.capability && artifactPath) {
      console.log(`  artifact: ${artifactPath} (${fin.capability.capability.status}; ${fin.capability.steps.length} steps, ${Object.keys(fin.capability.preludes).length} prelude(s), ${fin.prunedStepIds.length} pruned)`);
      for (const line of fin.capability.capability.summary) console.log(`    ${line}`);
    }
    const usage = result.usage;
    console.log(`  ${status}${trace.reason ? ` (${trace.reason})` : ""} in ${Math.round((Date.now() - started) / 1000)}s; ${usage.calls} model calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens${usage.estimatedCostUsd !== undefined ? ` (~$${usage.estimatedCostUsd.toFixed(3)})` : ""}`);
    process.exitCode = status === "completed" || status === "needsReview" ? 0 : status === "escalated" ? 3 : 2;
  } finally {
    await surface.close();
  }
}

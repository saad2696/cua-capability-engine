/**
 * Turning a finished discovery trace into the things a run is supposed to leave behind: a usage
 * record, a capability artifact, and a `run.json` describing both.
 *
 * This lived inside `cua discover` until the operator console needed the same thing. Duplicating it
 * would have meant a discovery started from the console produced no artifact at all — which is what
 * it did, and the console is the surface whose entire purpose is producing one. A capability that
 * exists only when a particular front end recorded it is not a capability, so there is one function
 * and both callers use it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DiscoveryResultSchema, artifactFileName, summarizeCapability, type Capability, type DiscoveryResult, type Outcome } from "@cua/schema";
import type { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import { estimateCostUsd } from "../llm/AnthropicProvider.js";
import type { Trace } from "../agent/loop.js";
import { recordCapability } from "./recorder.js";

export interface FinishDiscoveryOptions {
  runId: string;
  trace: Trace;
  secrets: Record<string, string>;
  evidence: EvidenceWriter;
  capabilityId: string;
  /** Human-readable capability name; defaults to the goal. */
  name?: string;
  vendor: string;
  /** The origin the capability is allowed to drive. */
  origin: string;
  provider: string;
  model: string;
  /** Where artifacts are written. Defaults to `artifacts`. */
  outDir?: string;
  /** Where the per-vendor default outcome catalog lives. Defaults to `artifacts/defaults`. */
  defaultsDir?: string;
}

export interface FinishedDiscovery {
  result: DiscoveryResult;
  capability?: Capability;
  artifactPath?: string;
  warnings: string[];
  prunedStepIds: string[];
}

/**
 * Writes `usage.json`, and for a completed run the artifact plus `artifact.json`, then `run.json`.
 * A run that did not complete still gets usage and a result — an escalated or abandoned run is
 * evidence too, and the cost was incurred either way.
 */
export function finishDiscovery(opts: FinishDiscoveryOptions): FinishedDiscovery {
  const { trace, evidence, runId } = opts;
  const cost = estimateCostUsd(opts.model, trace.usage.inputTokens, trace.usage.outputTokens);
  const usage = {
    provider: opts.provider,
    model: opts.model,
    calls: trace.usage.calls,
    inputTokens: trace.usage.inputTokens,
    outputTokens: trace.usage.outputTokens,
    ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
  };
  evidence.json("usage.json", usage, false);

  let artifactPath: string | undefined;
  let capability: Capability | undefined;
  let warnings: string[] = [];
  let prunedStepIds: string[] = [];
  let status: DiscoveryResult["status"] = trace.status;

  if (trace.status === "completed") {
    const defaultsPath = join(opts.defaultsDir ?? join("artifacts", "defaults"), `${opts.vendor}.outcomes.json`);
    const defaultOutcomes = existsSync(defaultsPath) ? (JSON.parse(readFileSync(defaultsPath, "utf8")) as Outcome[]) : [];
    const rec = recordCapability(trace, opts.secrets, {
      capabilityId: opts.capabilityId,
      name: opts.name ?? trace.goal,
      vendor: opts.vendor,
      allowedOrigins: [opts.origin],
      defaultOutcomes,
      provider: opts.provider,
      model: opts.model,
    });
    rec.capability.capability.summary = summarizeCapability(rec.capability);
    // A warning means a human has to look before this runs unattended; it is not a failure of the
    // run, so the artifact is still written — marked so the approval gate will hold it.
    if (rec.warnings.length) {
      rec.capability.capability.status = "needsReview";
      status = "needsReview";
    }
    warnings = rec.warnings;
    prunedStepIds = rec.prunedStepIds;
    capability = rec.capability;
    if (rec.prunedStepIds.length) evidence.event({ type: "pruned", removedStepIds: rec.prunedStepIds, reason: "detour or no-op" });

    const outDir = opts.outDir ?? "artifacts";
    mkdirSync(outDir, { recursive: true });
    artifactPath = join(outDir, artifactFileName(rec.capability));
    writeFileSync(artifactPath, JSON.stringify(rec.capability, null, 2) + "\n");
    evidence.json("artifact.json", rec.capability, false);
  }

  const result = DiscoveryResultSchema.parse({
    runId,
    status,
    goal: trace.goal,
    params: Object.fromEntries(Object.keys(trace.params).map((k) => [k, { kind: "param", name: k }])),
    ...(artifactPath ? { artifactPath } : {}),
    stepsTaken: trace.steps.length,
    prunedSteps: prunedStepIds.length,
    usage,
    ...(trace.reason ? { reason: trace.reason } : {}),
    evidenceDir: evidence.dir,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
  });
  evidence.json("run.json", result);

  return { result, ...(capability ? { capability } : {}), ...(artifactPath ? { artifactPath } : {}), warnings, prunedStepIds };
}

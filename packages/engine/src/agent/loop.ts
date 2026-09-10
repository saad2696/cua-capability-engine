/**
 * Discovery loop: observe → decide → act, recorded step by step. No artifact logic lives here;
 * the loop produces a Trace that the recorder turns into a Capability.
 */
import { randomUUID } from "node:crypto";
import type { ExtractionCandidate, Locator } from "@cua/schema";
import type { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import type { Decision, DecisionContext, HistoryEntry, LlmProvider } from "../llm/types.js";
import type { DiscoveryPolicy, PolicyVerdict } from "../policy/basic.js";
import type { Observation, Surface, SurfaceAction } from "../surface/types.js";

export interface ObservationSummary {
  at: string;
  url: string;
  title: string;
  frames: Observation["frames"];
  landmarks: Observation["landmarks"];
  elements: Observation["elements"];
  dialog?: Observation["dialog"];
  screenshot: string;
  /** Visible text of the content frames (redacted at write time), for outcome seeding and checkpoints. */
  text: string;
}

export interface TraceStep {
  index: number;
  before: ObservationSummary;
  decision: Decision;
  verdict: PolicyVerdict;
  /** Locator captured before acting (click/type/select). */
  locator?: Locator;
  /** Element the decision targeted, as observed before acting. */
  element?: Observation["elements"][number];
  /** The value actually typed/selected/navigated, unredacted; classified by the recorder. */
  rawValue?: string;
  /** What the typed placeholder referenced, when it did ({memberId} -> param, {TARGET_USER} -> secret). */
  valueRef?: { kind: "param" | "secret"; name: string };
  actOk: boolean;
  actError?: string;
  after?: ObservationSummary;
  /** Extract details, when decision.tool === "extract". */
  extract?: { output: string; value: string; description: string; verified: ExtractionCandidate[] };
}

export interface Trace {
  runId: string;
  goal: string;
  startUrl: string;
  params: Record<string, string>;
  steps: TraceStep[];
  final?: ObservationSummary;
  status: "completed" | "escalated" | "gave_up" | "failed";
  reason?: string;
  doneSummary?: string;
  usage: { calls: number; inputTokens: number; outputTokens: number };
  startedAt: string;
  finishedAt: string;
}

export interface DiscoveryOptions {
  goal: string;
  url: string;
  params: Record<string, string>;
  /** Secret name → value, resolved from the environment by the caller. */
  secrets: Record<string, string>;
  provider: LlmProvider;
  surface: Surface;
  policy: DiscoveryPolicy;
  evidence: EvidenceWriter;
  maxSteps?: number;
  timeoutMs?: number;
  /** Called when a risky action needs approval. Return true to proceed. Slice 007 wires this to the console. */
  approveRisky?: (decision: Decision, obs: Observation) => Promise<boolean>;
  /** Consecutive identical decisions that count as a dead end. */
  loopThreshold?: number;
  log?: (line: string) => void;
}

const PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Substitute {param}/{SECRET} placeholders. Returns the raw value and what it referenced. */
export function substitute(text: string, params: Record<string, string>, secrets: Record<string, string>): { value: string; ref?: { kind: "param" | "secret"; name: string } } {
  const m = PLACEHOLDER.exec(text.trim());
  if (m) {
    const name = m[1]!;
    if (name in params) return { value: params[name]!, ref: { kind: "param", name } };
    if (name in secrets) return { value: secrets[name]!, ref: { kind: "secret", name } };
  }
  // exact match on a param value typed literally still counts as that param (models sometimes copy the value)
  for (const [name, v] of Object.entries(params)) if (v && text === v) return { value: v, ref: { kind: "param", name } };
  for (const [name, v] of Object.entries(secrets)) if (v && text === v) return { value: v, ref: { kind: "secret", name } };
  return { value: text };
}

function summarize(obs: Observation, evidence: EvidenceWriter, label: string, text: string): ObservationSummary {
  return {
    at: obs.at, url: obs.url, title: obs.title, frames: obs.frames, landmarks: obs.landmarks, elements: obs.elements,
    ...(obs.dialog ? { dialog: obs.dialog } : {}), screenshot: evidence.screenshot(label, obs.screenshotPng), text,
  };
}

function describeDecision(d: Decision, obs: Observation, params: Record<string, string>, secrets: Record<string, string>): string {
  const el = (i: unknown) => {
    const e = obs.elements[Number(i)];
    return e ? `[${e.index}] ${e.role} "${e.name}"` : `[${String(i)}]`;
  };
  const val = (t: unknown) => {
    const s = substitute(String(t ?? ""), params, secrets);
    return s.ref ? `{${s.ref.name}}` : JSON.stringify(String(t ?? ""));
  };
  switch (d.tool) {
    case "click": return `click ${el(d.args["index"])}`;
    case "type": return `type ${val(d.args["text"])} into ${el(d.args["index"])}`;
    case "select": return `select ${JSON.stringify(d.args["option"])} in ${el(d.args["index"])}`;
    case "press": return `press ${String(d.args["key"])}`;
    case "navigate": return `navigate to ${String(d.args["url"])}`;
    case "extract": return `extract ${String(d.args["output"])} = ${val(d.args["value"])}`;
    case "assert_state": return `assert ${String(d.args["kind"])}: ${String(d.args["detail"])}`;
    case "done": return `done: ${String(d.args["summary"])}`;
    case "give_up": return `give up: ${String(d.args["reason"])}`;
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source matching the displayed value's shape (digit runs generalised) so replay tolerates a different balance. */
function valuePattern(value: string): string {
  return escapeRegex(value).replace(/\d[\d,]*/g, "[\\d,]+");
}

async function contentText(surface: Surface, obs: Observation): Promise<string> {
  // text of the deepest frames (content), skipping the top frameset document
  const leaf = obs.frames.filter((f) => f.path.length).map((f) => f.path);
  const parts: string[] = [];
  for (const p of leaf.length ? leaf : [undefined]) parts.push(await surface.visibleText(p).catch(() => ""));
  return parts.join("\n").slice(0, 4000);
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<Trace> {
  const { surface, provider, policy, evidence } = opts;
  const maxSteps = opts.maxSteps ?? 30;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const loopThreshold = opts.loopThreshold ?? 3;
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const trace: Trace = { runId: evidence.runId, goal: opts.goal, startUrl: opts.url, params: opts.params, steps: [], status: "failed", usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, startedAt, finishedAt: startedAt };
  const history: HistoryEntry[] = [];
  let notices: string[] = [];
  let repeat = { key: "", count: 0 };
  const recordedExtracts = new Set<string>();

  evidence.event({ type: "run_started", mode: "discover", goal: opts.goal });
  const finish = (status: Trace["status"], reason?: string): Trace => {
    trace.status = status;
    if (reason) trace.reason = reason;
    trace.finishedAt = new Date().toISOString();
    evidence.event({ type: "result", status, ...(reason ? { code: reason } : {}), summary: trace.doneSummary ?? reason ?? status });
    return trace;
  };

  try {
    await surface.open(opts.url);
  } catch (e) {
    evidence.event({ type: "error", code: "SURFACE_ERROR", message: (e as Error).message });
    return finish("failed", "SURFACE_ERROR");
  }

  for (let i = 0; i < maxSteps; i += 1) {
    if (Date.now() > deadline) return finish("failed", "RUN_TIMEOUT");
    const obs = await surface.observe();
    const before = summarize(obs, evidence, `step-${i + 1}-before`, await contentText(surface, obs));
    evidence.event({ type: "observe", stepIndex: i, url: obs.url, title: obs.title, elementCount: obs.elements.length, screenshot: before.screenshot, ...(obs.dialog ? { dialog: { type: obs.dialog.type, message: obs.dialog.message } } : {}) });

    const ctx: DecisionContext = { goal: opts.goal, params: opts.params, secretNames: Object.keys(opts.secrets), observation: obs, history, stepIndex: i, maxSteps, allowedOrigins: policy.allowedOrigins, notices };
    notices = [];
    let decision: Decision;
    try {
      decision = await provider.decide(ctx);
    } catch (e) {
      evidence.event({ type: "error", code: "PROVIDER_ERROR", message: (e as Error).message });
      return finish("failed", "PROVIDER_ERROR");
    }
    trace.usage.calls += 1;
    trace.usage.inputTokens += decision.usage?.inputTokens ?? 0;
    trace.usage.outputTokens += decision.usage?.outputTokens ?? 0;
    const summary = describeDecision(decision, obs, opts.params, opts.secrets);
    evidence.event({ type: "decide", stepIndex: i, tool: decision.tool, args: decision.args, reasoning: decision.reasoning, ...(decision.usage ? { usage: { inputTokens: decision.usage.inputTokens, outputTokens: decision.usage.outputTokens } } : {}) });
    log(`${i + 1}. ${summary}`);

    // dead-end detection (a repeated, already-successful extract is a harmless no-op, handled below)
    const key = `${decision.tool}:${JSON.stringify(decision.args)}`;
    const alreadyRecorded = decision.tool === "extract" && recordedExtracts.has(`${String(decision.args["output"])}=${String(decision.args["value"] ?? "").trim()}`);
    repeat = key === repeat.key ? { key, count: repeat.count + 1 } : { key, count: 1 };
    if (alreadyRecorded) {
      const output = String(decision.args["output"]);
      history.push({ step: i + 1, tool: "extract", summary, outcome: "ok", note: "already recorded" });
      notices.push(`Output "${output}" is already recorded with this value. Do not extract it again; if every requested value is recorded, call done.`);
      trace.steps.push({ index: i, before, decision, verdict: { allow: true, risk: "safe" }, actOk: false, actError: "duplicate extract (already recorded)" });
      if (repeat.count >= loopThreshold + 1) {
        // the model will not stop on its own; a recorded output is a completed goal for this value
        trace.doneSummary = `Recorded ${[...recordedExtracts].map((k) => k.split("=")[0]).join(", ")} (auto-completed after repeated extract)`;
        trace.final = before;
        return finish("completed");
      }
      continue;
    }
    if (repeat.count >= loopThreshold) {
      evidence.event({ type: "escalate", stepIndex: i, interventionId: "pending", reason: "LOOP_DETECTED", detail: `same action ${repeat.count} times: ${summary}`, screenshot: before.screenshot });
      return finish("escalated", "LOOP_DETECTED");
    }

    const step: TraceStep = { index: i, before, decision, verdict: { allow: true, risk: "safe" }, actOk: true };
    trace.steps.push(step);

    if (decision.tool === "done") {
      trace.doneSummary = String(decision.args["summary"] ?? "");
      trace.final = before;
      history.push({ step: i + 1, tool: "done", summary, outcome: "ok" });
      return finish("completed");
    }
    if (decision.tool === "give_up") {
      trace.final = before;
      evidence.event({ type: "escalate", stepIndex: i, interventionId: "pending", reason: "AGENT_GAVE_UP", detail: String(decision.args["reason"] ?? ""), screenshot: before.screenshot });
      return finish("gave_up", "AGENT_GAVE_UP");
    }
    if (decision.tool === "assert_state") {
      const kind = String(decision.args["kind"]);
      history.push({ step: i + 1, tool: "assert_state", summary, outcome: "ok" });
      if (kind === "needs_human_confirmation") {
        evidence.event({ type: "risk_flag", stepIndex: i, action: "assert_state", reason: String(decision.args["detail"] ?? "") });
        const ok = opts.approveRisky ? await opts.approveRisky(decision, obs) : false;
        if (!ok) {
          evidence.event({ type: "escalate", stepIndex: i, interventionId: "pending", reason: "RISKY_STEP_NEEDS_APPROVAL", detail: String(decision.args["detail"] ?? ""), screenshot: before.screenshot });
          trace.final = before;
          return finish("escalated", "RISKY_STEP_NEEDS_APPROVAL");
        }
        notices.push("A human approved the irreversible step you described. You may perform it now.");
      }
      continue;
    }

    // policy
    const verdict = policy.check(decision, obs);
    step.verdict = verdict;
    if (!verdict.allow) {
      evidence.event({ type: "policy_block", stepIndex: i, action: summary, reason: verdict.reason ?? "blocked", controller: "agent" });
      history.push({ step: i + 1, tool: decision.tool, summary, outcome: "blocked", ...(verdict.reason ? { note: verdict.reason } : {}) });
      notices.push(`Blocked by policy: ${verdict.reason ?? "not allowed"}. Choose a different action.`);
      step.actOk = false;
      step.actError = verdict.reason ?? "blocked";
      continue;
    }
    if (verdict.risk === "risky") {
      evidence.event({ type: "risk_flag", stepIndex: i, action: summary, reason: verdict.reason ?? "risky" });
      const ok = opts.approveRisky ? await opts.approveRisky(decision, obs) : false;
      if (!ok) {
        evidence.event({ type: "escalate", stepIndex: i, interventionId: "pending", reason: "RISKY_STEP_NEEDS_APPROVAL", detail: `${summary}: ${verdict.reason ?? ""}`, screenshot: before.screenshot });
        trace.final = before;
        return finish("escalated", "RISKY_STEP_NEEDS_APPROVAL");
      }
    }

    // extract: verify the model's reading can be re-read deterministically
    if (decision.tool === "extract") {
      const output = String(decision.args["output"] ?? "");
      const value = String(decision.args["value"] ?? "").trim();
      // try each content frame; record the frame in which the value was actually found
      const contentFrames = obs.frames.filter((f) => f.path.length).map((f) => f.path);
      const framesToTry: (string[] | undefined)[] = contentFrames.length ? contentFrames : [undefined];
      const candidates: ExtractionCandidate[] = [];
      const rowLabel = decision.args["rowLabel"] ? String(decision.args["rowLabel"]).trim() : undefined;
      const columnHeader = decision.args["columnHeader"] ? String(decision.args["columnHeader"]).trim() : undefined;
      const nearLabel = decision.args["nearLabel"] ? String(decision.args["nearLabel"]).trim() : undefined;
      // Anchors must not carry parameter or secret values (e.g. an account number that embeds the
      // member id), or the strategy only works for this invocation. Try the full label first, then
      // its individual tokens, keeping only clean ones.
      const taboo = [...Object.values(opts.params), ...Object.values(opts.secrets)].filter((v) => v.length >= 2);
      const isClean = (s: string) => !taboo.some((v) => s.includes(v));
      const anchors = (label: string | undefined): string[] => {
        if (!label) return [];
        const parts = [label, ...label.split(/\s+/).filter((t) => t.length >= 3)];
        return [...new Set(parts)].filter(isClean);
      };
      for (const row of anchors(rowLabel)) if (columnHeader && isClean(columnHeader)) candidates.push({ strategy: "tableCell", rowMatch: row, columnHeader });
      for (const label of anchors(nearLabel)) candidates.push({ strategy: "cellRightOfLabel", label });
      for (const anchor of [...anchors(rowLabel), ...anchors(nearLabel)].slice(0, 3)) candidates.push({ strategy: "regexInRegion", pattern: `${escapeRegex(anchor)}[\\s\\S]{0,160}?(${valuePattern(value)})`, group: 1 });
      const verified: ExtractionCandidate[] = [];
      for (const c of candidates) {
        for (const frame of framesToTry) {
          const withFrame = (frame ? { ...c, frame } : c) as ExtractionCandidate;
          const got = await surface.extract(withFrame, frame);
          if (got !== null && got.replace(/\s+/g, " ").trim() === value) {
            verified.push(withFrame);
            break;
          }
        }
      }
      const onScreen = before.text.includes(value);
      const ok = onScreen && verified.length > 0;
      step.extract = { output, value, description: String(decision.args["description"] ?? ""), verified };
      step.actOk = ok;
      evidence.event({ type: "extract", stepIndex: i, output, strategy: verified.map((c) => c.strategy).join(",") || "none", raw: value, parsed: value });
      history.push({ step: i + 1, tool: "extract", summary, outcome: ok ? "ok" : "failed", ...(ok ? { note: "recorded" } : { note: onScreen ? "could not find a deterministic way to re-read this value; give rowLabel+columnHeader or nearLabel" : "value not visible on screen" }) });
      if (ok) {
        recordedExtracts.add(`${output}=${value}`);
        notices.push(`Output "${output}" = ${value} is recorded. If every requested value is recorded, call done now.`);
      } else {
        const tabooHint = [rowLabel, nearLabel].some((s) => s && !isClean(s)) ? " The label you gave contains the parameter value (e.g. an account number that embeds the member id); use a label that is the same for every member, such as the account type." : "";
        notices.push(onScreen ? `extract "${output}": I could not re-read "${value}" deterministically.${tabooHint} Provide rowLabel and columnHeader (for tables) or nearLabel (for label/value rows).` : `extract "${output}": "${value}" is not visible on the current screen.`);
      }
      step.after = before;
      continue;
    }

    // build the surface action
    let action: SurfaceAction;
    const idx = Number(decision.args["index"]);
    const targetEl = Number.isInteger(idx) ? obs.elements[idx] : undefined;
    if (["click", "type", "select"].includes(decision.tool)) {
      if (!targetEl) {
        history.push({ step: i + 1, tool: decision.tool, summary, outcome: "failed", note: "no such element number" });
        notices.push(`There is no element [${String(decision.args["index"])}]. Use a number from the list.`);
        step.actOk = false;
        step.actError = "no such element";
        continue;
      }
      step.element = targetEl;
      try {
        step.locator = await surface.captureLocator(targetEl.index);
      } catch (e) {
        step.actError = `captureLocator: ${(e as Error).message}`;
      }
    }
    switch (decision.tool) {
      case "click": action = { kind: "click", target: { index: idx } }; break;
      case "type": {
        const sub = substitute(String(decision.args["text"] ?? ""), opts.params, opts.secrets);
        step.rawValue = sub.value;
        if (sub.ref) step.valueRef = sub.ref;
        action = { kind: "type", target: { index: idx }, text: sub.value, secret: sub.ref?.kind === "secret" };
        break;
      }
      case "select": step.rawValue = String(decision.args["option"] ?? ""); action = { kind: "select", target: { index: idx }, value: step.rawValue }; break;
      case "press": step.rawValue = String(decision.args["key"] ?? ""); action = { kind: "press", key: step.rawValue }; break;
      case "navigate": step.rawValue = String(decision.args["url"] ?? ""); action = { kind: "navigate", url: step.rawValue }; break;
      default: continue;
    }
    const res = await surface.act(action);
    step.actOk = res.ok;
    if (res.error) step.actError = res.error;
    evidence.event({ type: "act", stepIndex: i, action: decision.tool, ...(targetEl ? { target: `${targetEl.role} "${targetEl.name}"` } : {}), ...(step.rawValue !== undefined && decision.tool !== "type" ? { value: step.rawValue } : {}), controller: "agent", ok: res.ok, ...(res.error ? { error: res.error } : {}) });
    const afterObs = await surface.observe();
    step.after = summarize(afterObs, evidence, `step-${i + 1}-after`, await contentText(surface, afterObs));
    history.push({ step: i + 1, tool: decision.tool, summary, outcome: res.ok ? "ok" : "failed", ...(res.error ? { note: res.error } : {}) });
    if (!res.ok) notices.push(`The last action failed: ${res.error ?? "unknown error"}.`);
    if (afterObs.dialog) notices.push(`A ${afterObs.dialog.type} dialog appeared: "${afterObs.dialog.message}".`);
  }
  evidence.event({ type: "escalate", interventionId: "pending", reason: "MAX_STEPS_REACHED", detail: `stopped after ${maxSteps} steps` });
  return finish("escalated", "MAX_STEPS_REACHED");
}

export function newRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "").slice(0, 13)}-${randomUUID().slice(0, 6)}`;
}

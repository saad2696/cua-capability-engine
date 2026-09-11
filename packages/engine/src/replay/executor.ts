/**
 * Deterministic replay executor — the production path. No model anywhere.
 *
 * For each step: precondition (screen signature) → resolve → act → wait → expect → detect.
 * Detectors classify the screen against the artifact's outcome catalog: business outcomes end
 * the run as a legitimate result, recoverable outcomes apply a bounded recovery and continue,
 * failure outcomes stop with debuggable detail (optionally escalating). Every result carries the
 * side-effect state so callers never retry a committed action blindly.
 */
import { randomUUID } from "node:crypto";
import {
  EXIT_CODES, ReplayResultSchema, isRetryable,
  type Capability, type EscalationReason, type FailureCode, type Outcome, type ReplayResult, type SideEffects, type Step,
} from "@cua/schema";
import type { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import type { Surface, SurfaceAction } from "../surface/types.js";
import { describeAssertion, waitForAssertion, type Verdict } from "./assertions.js";
import { captureScreenState, matchOutcomes, type ScreenState } from "./detectors.js";
import { extractOutput } from "./extraction.js";
import { preflight, type PreflightOptions } from "./preflight.js";
import { checkSignature, describeSignature } from "./signature.js";
import { describeValue, resolveValue, type ValueContext } from "./values.js";
import { performWait } from "./waits.js";

export interface EscalationRequest {
  interventionId: string;
  reason: EscalationReason;
  stepId?: string;
  stepIndex: number;
  detail: string;
  screenshot?: string;
}

export interface ReplayOptions {
  artifact: unknown;
  params: Record<string, string>;
  secrets: Record<string, string>;
  surface: Surface;
  evidence: EvidenceWriter;
  /** Global policy; the artifact's own policy must be a subset. */
  globalPolicy?: { allowedOrigins?: string[]; allowedActions?: string[] };
  requireApproved?: boolean;
  allowDraft?: boolean;
  riskyStepsRequire?: "approvedArtifact" | "humanConfirm" | "block";
  escalateOnFailure?: boolean;
  runTimeoutMs?: number;
  slowThresholdMs?: number;
  /** Resume support (slice 007): start the main flow at this step index, skipping preludes. */
  startAtStepIndex?: number;
  /** Human-in-the-loop hooks (slice 007 wires these to the console). */
  onEscalate?: (req: EscalationRequest) => Promise<"same" | "next" | "abort">;
  confirmRisky?: (step: Step) => Promise<boolean>;
  /** Called between steps; return "abort" to stop (session control). */
  shouldContinue?: () => Promise<"continue" | "abort">;
  signal?: AbortSignal;
  /** Demo/test hook: set before the run starts (e.g. the mock app's fault cookie). */
  cookies?: { url: string; name: string; value: string }[];
  log?: (line: string) => void;
}

/** Runs in progress, for the run lock. Module-level: one engine process, one lock table. */
const RUNNING = new Set<string>();

class Stop extends Error {
  constructor(readonly result: ReplayResult) {
    super(result.status);
  }
}

/** Thrown by a recovery that re-established a precondition (e.g. re-login): the affected sequence starts over. */
class Restart extends Error {
  constructor(readonly phase: "prelude" | "main") {
    super(`restart ${phase}`);
  }
}

type Phase = "prelude" | "main";

interface RunState {
  cap: Capability;
  ctx: ValueContext;
  outputs: Record<string, unknown>;
  sideEffects: SideEffects;
  drift: ReplayResult["drift"];
  recoveries: ReplayResult["recoveries"];
  recoveryCounts: Map<string, number>;
  stepsRun: number;
  startedAt: string;
  deadline: number;
  /** Name of the prelude currently executing, if any (suppresses that prelude's own recovery). */
  activePrelude: string | undefined;
  lastScreenshot?: string;
}

const BACKOFF_MS = [500, 1500, 4000];

/** Below this box overlap, a resolved control is reported as having moved. Soft: never fails a run. */
const VISUAL_DRIFT_THRESHOLD = 0.6;

/** Intersection over union of two page-coordinate boxes: 1 when unmoved, 0 when disjoint. */
function boxSimilarity(a: readonly number[], b: readonly number[]): number {
  const [ax, ay, aw, ah] = [a[0]!, a[1]!, a[2]!, a[3]!];
  const [bx, by, bw, bh] = [b[0]!, b[1]!, b[2]!, b[3]!];
  const ix = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const iy = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = ix * iy;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { surface, evidence } = opts;
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const pre = preflight(opts.artifact, {
    params: opts.params, secrets: opts.secrets,
    ...(opts.globalPolicy?.allowedOrigins ? { globalAllowedOrigins: opts.globalPolicy.allowedOrigins } : {}),
    ...(opts.globalPolicy?.allowedActions ? { globalAllowedActions: opts.globalPolicy.allowedActions } : {}),
    requireApproved: opts.requireApproved ?? true, allowDraft: opts.allowDraft ?? false, running: RUNNING,
  } satisfies PreflightOptions);

  const rawCap = (opts.artifact ?? {}) as { capability?: { id?: string; version?: number } };
  const common = (state?: RunState) => ({
    runId: evidence.runId, capabilityId: state?.cap.capability.id ?? rawCap.capability?.id ?? "unknown", capabilityVersion: state?.cap.capability.version ?? rawCap.capability?.version ?? 1,
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0, stepsRun: state?.stepsRun ?? 0, sideEffects: state?.sideEffects ?? ("none" as const),
    drift: state?.drift ?? [], recoveries: state?.recoveries ?? [], evidenceDir: evidence.dir,
  });

  if (!pre.ok) {
    evidence.event({ type: "run_started", mode: "replay", capabilityId: rawCap.capability?.id ?? "unknown" });
    const result: ReplayResult = { status: "failure", code: pre.code, expected: pre.expected, observed: pre.observed, evidence: {}, ...common() };
    evidence.event({ type: "result", status: "failure", code: pre.code, summary: `pre-flight: ${pre.expected} — ${pre.observed}` });
    evidence.json("result.json", result);
    return ReplayResultSchema.parse(result);
  }

  const cap = pre.capability;
  const state: RunState = {
    cap, ctx: { params: opts.params, secrets: opts.secrets }, outputs: {}, sideEffects: "none", drift: [], recoveries: [], recoveryCounts: new Map(),
    stepsRun: 0, startedAt, deadline: t0 + (opts.runTimeoutMs ?? 300_000), activePrelude: undefined,
  };
  RUNNING.add(pre.lockKey);
  evidence.event({ type: "run_started", mode: "replay", capabilityId: cap.capability.id });
  log(`replay ${cap.capability.id}@${cap.capability.version} (${cap.capability.status})`);

  const finish = (result: ReplayResult): ReplayResult => {
    const parsed = ReplayResultSchema.parse(result);
    evidence.event({ type: "result", status: parsed.status, ...("code" in parsed ? { code: parsed.code } : "reason" in parsed ? { code: parsed.reason } : {}), summary: summaryOf(parsed) });
    evidence.json("result.json", parsed);
    return parsed;
  };

  // ---- failure bundle ----
  type Bundle = { screenshot?: string; fullPage?: string; a11y?: string; trace?: string; narrative?: string };
  /**
   * Collect what a human needs to debug a failure. Every call is raced against a short budget: the
   * browser may be mid-navigation or already torn down when we get here, and Playwright's own
   * defaults would otherwise stall the run for tens of seconds after it has already failed.
   */
  const withBudget = async <T,>(ms: number, fn: () => Promise<T>): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([fn(), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]);
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const failureBundle = async (label: string, cheap = false): Promise<Bundle> => {
    const out: Bundle = {};
    // A cancelled run is not a mystery to debug, and its page is being torn down: skip the slow shot.
    if (!cheap) {
      const full = await withBudget(5000, () => surface.screenshot({ fullPage: true }));
      if (full?.length) out.fullPage = evidence.screenshot(`${label}-fullpage`, full);
    }
    const obs = await withBudget(5000, () => surface.observe());
    if (obs) {
      out.screenshot = evidence.screenshot(`${label}-viewport`, obs.rawScreenshotPng);
      out.a11y = evidence.json(`${label}-a11y.json`, { url: obs.url, frames: obs.frames, landmarks: obs.landmarks, elements: obs.elements, dialog: obs.dialog ?? null });
    }
    const text = await withBudget(3000, () => surface.visibleText());
    if (text !== undefined) evidence.text(`${label}-text.txt`, text);
    return out;
  };

  class Resume extends Error {
    constructor(readonly at: "same" | "next") {
      super("resume");
    }
  }

  const fail = async (code: FailureCode, step: Step | undefined, expected: string, observed: string): Promise<never> => {
    const label = `failure-${step?.id.replace("step:", "") ?? "run"}`;
    const bundle = await failureBundle(label, code === "CANCELLED" || code === "RUN_TIMEOUT");
    const narrative = [
      `# Replay failure: ${code}`, "",
      `Capability: ${cap.capability.id}@${cap.capability.version}`, `Step: ${step ? `${step.id} — ${step.intent}` : "(run level)"}`, `Side effects: ${state.sideEffects}`, "",
      `**Expected:** ${expected}`, `**Observed:** ${observed}`, "",
      "## Suggested next action", suggestion(code, state.sideEffects), "",
      "## Evidence", ...Object.entries(bundle).map(([k, v]) => `- ${k}: ${String(v)}`),
    ].join("\n");
    const narrativePath = evidence.text(`${label}.md`, narrative);
    if (opts.escalateOnFailure && opts.onEscalate) {
      const decision = await escalate("REPLAY_FAILURE", step, state.stepsRun, `${code}: ${expected} — ${observed}`);
      if (decision !== "abort") throw new Resume(decision);
    }
    if (opts.escalateOnFailure && !opts.onEscalate) {
      const id = `intervention-${randomUUID().slice(0, 8)}`;
      evidence.event({ type: "escalate", ...(step ? { stepId: step.id } : {}), interventionId: id, reason: "REPLAY_FAILURE", detail: `${code}: ${expected} — ${observed}`, ...(bundle.screenshot ? { screenshot: bundle.screenshot } : {}) });
      throw new Stop({ status: "escalated", interventionId: id, reason: "REPLAY_FAILURE", ...(step ? { atStep: step.id } : {}), detail: `${code}: ${expected} — ${observed}`, ...common(state) });
    }
    throw new Stop({ status: "failure", code, ...(step ? { atStep: step.id } : {}), expected, observed, evidence: { ...bundle, narrative: narrativePath }, ...common(state) });
  };

  const business = (o: Outcome, step: Step | undefined): never => {
    throw new Stop({ status: "business_outcome", code: o.code, message: o.message, ...(step ? { atStep: step.id } : {}), outputs: state.outputs, ...common(state) });
  };

  const escalate = async (reason: EscalationReason, step: Step | undefined, stepIndex: number, detail: string): Promise<"same" | "next" | "abort"> => {
    const id = `intervention-${randomUUID().slice(0, 8)}`;
    let screenshot: string | undefined;
    try {
      screenshot = evidence.screenshot(`escalate-${step?.id.replace("step:", "") ?? "run"}`, (await surface.observe()).rawScreenshotPng);
    } catch {
      /* ignore */
    }
    evidence.event({ type: "escalate", ...(step ? { stepId: step.id } : {}), stepIndex, interventionId: id, reason, detail, ...(screenshot ? { screenshot } : {}) });
    if (!opts.onEscalate) throw new Stop({ status: "escalated", interventionId: id, reason, ...(step ? { atStep: step.id } : {}), detail, ...common(state) });
    const decision = await opts.onEscalate({ interventionId: id, reason, ...(step ? { stepId: step.id } : {}), stepIndex, detail, ...(screenshot ? { screenshot } : {}) });
    evidence.event({ type: "resume", ...(step ? { stepId: step.id } : {}), resumeAt: decision });
    if (decision === "abort") throw new Stop({ status: "escalated", interventionId: id, reason, ...(step ? { atStep: step.id } : {}), detail: `${detail} (aborted by operator)`, ...common(state) });
    return decision;
  };

  // ---- detectors ----
  const classify = async (
    step: Step | undefined,
    stepIndex: number,
    screen?: ScreenState,
    where: "precondition" | "postcondition" = "postcondition",
  ): Promise<{ outcome: Outcome; state: ScreenState } | undefined> => {
    const s = screen ?? (await captureScreenState(surface));
    // A recovery cannot be triggered by the screen it exists to reach. The sign-in screen matches
    // SESSION_EXPIRED, and it is also where the login prelude legitimately *starts* — so that outcome
    // is inert while checking a precondition inside its own prelude. It stays live for postconditions:
    // seeing the sign-in screen after submitting credentials means the sign-in did not stick.
    const suppressOwn = where === "precondition" && state.activePrelude !== undefined;
    const candidates = suppressOwn ? cap.outcomes.filter((o) => o.recover !== `prelude:${state.activePrelude}`) : cap.outcomes;
    const matched = matchOutcomes(candidates, s, step?.id);
    const o = matched[0];
    if (!o) return undefined;
    evidence.event({ type: "detect", ...(step ? { stepId: step.id } : {}), stepIndex, code: o.code, kind: o.kind, detail: o.message });
    log(`  detect ${o.code} (${o.kind})`);
    return { outcome: o, state: s };
  };

  /** Apply a recoverable outcome's recovery. Returns true when the caller should re-run the current step, false when it should only re-verify. */
  const recover = async (o: Outcome, step: Step | undefined, stepIndex: number, phase: Phase): Promise<"rerun" | "reverify"> => {
    const isPrelude = typeof o.recover === "string" && o.recover.startsWith("prelude:");
    const key = isPrelude ? `${o.code}@run` : `${o.code}@${step?.id ?? "run"}`;
    const n = (state.recoveryCounts.get(key) ?? 0) + 1;
    state.recoveryCounts.set(key, n);
    if (n > o.maxRecoveries) await fail("RECOVERY_LOOP", step, `at most ${o.maxRecoveries} recovery(ies) for ${o.code}`, `${o.code} triggered ${n} times at this step`);
    const recovery = o.recover!;
    log(`  recover ${o.code} via ${recovery} (attempt ${n})`);
    let ok = true;
    let mode: "rerun" | "reverify" = "rerun";
    try {
      if (recovery === "dismissDialog") {
        const r = await surface.act({ kind: "dismissDialog", accept: true });
        ok = r.ok;
        mode = "reverify";
      } else if (recovery === "retry") {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)]));
        mode = step && isRetryable(step) ? "rerun" : "reverify";
      } else if (recovery === "reload") {
        await surface.reload(step?.target?.frame ?? step?.precondition?.frames);
        mode = step && isRetryable(step) ? "rerun" : "reverify";
      } else if (recovery.startsWith("prelude:")) {
        const name = recovery.slice("prelude:".length);
        state.recoveries.push({ stepId: step?.id ?? "step:run", code: o.code, recovery, attempt: n });
        evidence.event({ type: "recover", ...(step ? { stepId: step.id } : {}), stepIndex, code: o.code, recovery, attempt: n, ok: true });
        if (phase === "prelude") throw new Restart("prelude"); // login did not stick: start the prelude over
        // the precondition (e.g. an authenticated session) was lost mid-flow: re-establish it, then the
        // main flow must start over, because earlier data entry (typed ids) is gone with the session
        if (state.sideEffects !== "none") {
          // Distinct from RECOVERY_LOOP: the recovery itself is sound, but replaying the flow from the
          // top would repeat an action that has already been committed downstream. A human must look.
          state.sideEffects = "possible";
          await fail("UNSAFE_RESTART", step, "a recoverable condition before any point of no return", `${o.code} after a committed action; restarting the flow could duplicate it`);
        }
        await runSequence(cap.preludes[name] ?? [], "prelude", 0, name);
        throw new Restart("main");
      }
    } catch (e) {
      if (e instanceof Stop || e instanceof Restart) throw e;
      ok = false;
    }
    state.recoveries.push({ stepId: step?.id ?? "step:run", code: o.code, recovery, attempt: n });
    evidence.event({ type: "recover", ...(step ? { stepId: step.id } : {}), stepIndex, code: o.code, recovery, attempt: n, ok });
    if (!ok) await fail("SURFACE_ERROR", step, `recovery ${recovery} to succeed`, `recovery failed`);
    return mode;
  };

  /** Run a step sequence; a Restart for this phase starts it over (bounded). */
  const runSequence = async (steps: Step[], phase: Phase, startIndex = 0, preludeName?: string): Promise<void> => {
    const outerPrelude = state.activePrelude;
    if (phase === "prelude" && preludeName) state.activePrelude = preludeName;
    let restarts = 0;
    try {
    for (let i = startIndex; i < steps.length; i += 1) {
      try {
        await runStep(steps[i]!, i, phase);
      } catch (e) {
        if (e instanceof Restart && e.phase === phase) {
          restarts += 1;
          if (restarts > 3) await fail("RECOVERY_LOOP", steps[i], `at most 3 restarts of the ${phase} sequence`, `restarted ${restarts} times`);
          log(`  restart ${phase} sequence`);
          i = startIndex - 1;
          continue;
        }
        if (e instanceof Resume && phase === "main") {
          if (e.at === "same") i -= 1;
          continue;
        }
        throw e;
      }
    }
    } finally {
      state.activePrelude = outerPrelude;
    }
  };

  /** Handle whatever the detectors found after a step. Returns "continue" | "rerun" | "reverify". */
  const handleDetection = async (found: { outcome: Outcome; state: ScreenState } | undefined, step: Step, stepIndex: number, phase: Phase): Promise<"continue" | "rerun" | "reverify"> => {
    if (!found) return "continue";
    const o = found.outcome;
    if (o.kind === "business") business(o, step);
    if (o.kind === "recoverable") return recover(o, step, stepIndex, phase);
    // failure outcome
    const detail = found.state.observation.dialog ? `${found.state.observation.dialog.type}: "${found.state.observation.dialog.message}"` : o.message;
    if (o.escalate) {
      const decision = await escalate("OUTCOME_ESCALATE", step, stepIndex, `${o.code}: ${detail}`);
      return decision === "same" ? "rerun" : "continue";
    }
    const code: FailureCode = found.state.observation.dialog ? "UNKNOWN_DIALOG" : (["LOCATOR_NOT_FOUND", "CHECKPOINT_FAILED", "NAVIGATION_BLOCKED", "SESSION_LOST"] as FailureCode[]).includes(o.code as FailureCode) ? (o.code as FailureCode) : "CHECKPOINT_FAILED";
    return fail(code, step, `no ${o.code}`, detail);
  };

  // ---- one step ----
  const runStep = async (step: Step, index: number, phase: Phase, attempt = 1): Promise<void> => {
    if (opts.signal?.aborted) await fail("CANCELLED", step, "run to continue", "cancelled by caller");
    if (Date.now() > state.deadline) await fail("RUN_TIMEOUT", step, `run within ${opts.runTimeoutMs ?? 300_000}ms`, "run budget exhausted");
    if (opts.shouldContinue && (await opts.shouldContinue()) === "abort") await fail("CANCELLED", step, "run to continue", "aborted by session controller");
    const frame = step.target?.frame ?? step.precondition?.frames;
    const label = `${phase}:${step.id}`;
    log(`${label} ${step.action}${step.target ? ` ${step.target.candidates[0]?.strategy}` : ""}${step.value ? ` ${describeValue(step.value)}` : ""}`);

    // 1. precondition
    if (step.precondition) {
      let sig = await checkSignature(step.precondition, surface, state.ctx);
      if (!sig.ok) {
        await new Promise((r) => setTimeout(r, 300));
        sig = await checkSignature(step.precondition, surface, state.ctx);
      }
      evidence.event({ type: "precondition", stepId: step.id, stepIndex: index, ok: sig.ok, expectedLandmarks: step.precondition.landmarks.map((l) => `${l.role} "${l.name}"`), observedLandmarks: sig.landmarksFound });
      if (!sig.ok) {
        const found = await classify(step, index, undefined, "precondition");
        if (found) {
          const next = await handleDetection(found, step, index, phase);
          if (next === "rerun") return runStep(step, index, phase, attempt);
        }
        const again = await checkSignature(step.precondition, surface, state.ctx);
        if (!again.ok) {
          if (step.optional) {
            evidence.event({ type: "skipped_optional", stepId: step.id, stepIndex: index, reason: "precondition not met" });
            log(`  skipped optional step`);
            return;
          }
          await fail("WRONG_SCREEN", step, describeSignature(step.precondition), `url ok: ${again.urlOk}; found: [${again.landmarksFound.join(", ")}]; missing: [${again.landmarksMissing.join(", ")}]${again.negativesHit.length ? `; negatives: ${again.negativesHit.join("; ")}` : ""}`);
        }
      }
    }

    // 2. risk gate
    if (step.risk === "risky") {
      const mode = opts.riskyStepsRequire ?? "approvedArtifact";
      let allowed = false;
      if (mode === "approvedArtifact") allowed = cap.capability.status === "approved";
      else if (mode === "humanConfirm") allowed = opts.confirmRisky ? await opts.confirmRisky(step) : false;
      if (!allowed) {
        if (mode === "block") await fail("POLICY_VIOLATION", step, "no risky steps (policy: block)", `${step.id} is risky`);
        const decision = await escalate("RISKY_STEP_NEEDS_APPROVAL", step, index, `${step.intent} (${step.action} on ${step.target?.candidates[0] ? JSON.stringify(step.target.candidates[0]) : "?"})`);
        if (decision === "next") return; // operator performed it manually
      }
      evidence.event({ type: "risk_flag", stepId: step.id, stepIndex: index, action: step.action, reason: "risky step approved for execution" });
      if (step.pointOfNoReturn) state.sideEffects = "possible";
    }

    // 3. act
    const beforeUrl = surface.frameUrl(frame);
    const actStarted = Date.now();
    if (step.action === "extract") {
      const spec = cap.outputs[step.output!];
      if (!spec) await fail("INVALID_ARTIFACT", step, `output ${step.output} declared`, "missing");
      const r = await extractOutput(step.output!, spec!, surface, frame);
      if (!r.ok) {
        const found = await classify(step, index);
        if (found) {
          const next = await handleDetection(found, step, index, phase);
          if (next !== "continue") return runStep(step, index, phase, attempt);
        }
        await fail("EXTRACTION_FAILED", step, `${step.output} via ${spec!.extract.candidates.map((c) => c.strategy).join(" → ")}`, r.error ?? "no value");
      }
      state.outputs[step.output!] = r.parsed;
      evidence.event({ type: "extract", stepId: step.id, stepIndex: index, output: step.output!, strategy: r.strategy!, raw: r.raw!, parsed: r.parsed });
      if ((r.candidateIndex ?? 0) > 0) {
        state.drift.push({ stepId: step.id, primaryStrategy: spec!.extract.candidates[0]!.strategy, matchedStrategy: r.strategy!, candidateIndex: r.candidateIndex! });
        evidence.event({ type: "drift", stepId: step.id, stepIndex: index, primaryStrategy: spec!.extract.candidates[0]!.strategy, matchedStrategy: r.strategy! });
      }
      log(`  extracted ${step.output} = ${JSON.stringify(r.parsed)} via ${r.strategy}`);
    } else if (step.action !== "assert") {
      let action: SurfaceAction;
      switch (step.action) {
        case "navigate": action = { kind: "navigate", url: resolveValue(step.value!, state.ctx) }; break;
        case "click": action = { kind: "click", target: { locator: step.target! } }; break;
        case "type": action = { kind: "type", target: { locator: step.target! }, text: resolveValue(step.value!, state.ctx), secret: step.value!.kind === "secret" }; break;
        case "select": action = { kind: "select", target: { locator: step.target! }, value: resolveValue(step.value!, state.ctx) }; break;
        case "press": action = { kind: "press", key: resolveValue(step.value!, state.ctx) }; break;
        case "dismissDialog": action = { kind: "dismissDialog", accept: true }; break;
      }
      const res = await surface.act(action);
      evidence.event({ type: "act", stepId: step.id, stepIndex: index, action: step.action, ...(step.target ? { target: step.target.candidates[0] ? `${step.target.candidates[0].strategy}` : "?" } : {}), ...(step.value && step.value.kind !== "secret" ? { value: describeValue(step.value) } : {}), controller: "replay", ok: res.ok, ...(res.error ? { error: res.error } : {}) });
      if (res.resolved) {
        evidence.event({ type: "resolve", stepId: step.id, stepIndex: index, matchedStrategy: res.resolved.strategy, candidateIndex: res.resolved.candidateIndex, attempts: res.resolved.attempts });
        // Soft signal: the right control was found, but it is not where it was recorded. A relayout
        // never fails a run on its own — it is the early warning that the screen is changing under us.
        const recordedBox = step.target?.recordedBBox;
        if (recordedBox) {
          const sim = boxSimilarity(recordedBox, res.resolved.bbox);
          if (sim < VISUAL_DRIFT_THRESHOLD) {
            evidence.event({ type: "visual_drift", stepId: step.id, stepIndex: index, similarity: Number(sim.toFixed(3)), threshold: VISUAL_DRIFT_THRESHOLD });
            log(`  visual drift: control moved (overlap ${(sim * 100).toFixed(0)}%)`);
          }
        }
        if (res.resolved.candidateIndex > 0) {
          const primary = step.target!.candidates[0]!.strategy;
          state.drift.push({ stepId: step.id, primaryStrategy: primary, matchedStrategy: res.resolved.strategy, candidateIndex: res.resolved.candidateIndex });
          evidence.event({ type: "drift", stepId: step.id, stepIndex: index, primaryStrategy: primary, matchedStrategy: res.resolved.strategy });
          log(`  drift: ${primary} → ${res.resolved.strategy}`);
        }
      }
      if (!res.ok) {
        if (res.error === "LOCATOR_NOT_FOUND") {
          // the screen may explain it (e.g. session expired) before we blame the locator
          const found = await classify(step, index);
          if (found) {
            const next = await handleDetection(found, step, index, phase);
            if (next !== "continue") return runStep(step, index, phase, attempt);
          }
          const obs = await surface.observe();
          await fail("LOCATOR_NOT_FOUND", step, `one of ${step.target!.candidates.map((c) => c.strategy + ("name" in c ? ` "${c.name}"` : "text" in c ? ` "${c.text}"` : "selector" in c ? ` ${c.selector}` : "")).join(" | ")} in frame ${step.target!.frame.join("/") || "(top)"}`, `visible: ${obs.elements.slice(0, 10).map((e) => `${e.role} "${e.name}"`).join(", ") || "nothing interactive"}${obs.dialog ? `; dialog open: ${obs.dialog.message}` : ""}`);
        }
        if (res.error?.startsWith("dialog open")) {
          const found = await classify(step, index);
          const next = await handleDetection(found, step, index, phase);
          if (next !== "continue") return runStep(step, index, phase, attempt);
        }
        if (res.error?.includes("blocked by policy")) await fail("NAVIGATION_BLOCKED", step, "navigation within the allowlist", res.error);
        if (isRetryable(step) && attempt < 3) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          return runStep(step, index, phase, attempt + 1);
        }
        await fail("SURFACE_ERROR", step, `${step.action} to succeed`, res.error ?? "unknown error");
      }
    }

    // 4. wait
    const waited = await performWait(step.wait, surface, { frameUrl: beforeUrl }, frame);
    const elapsed = Date.now() - actStarted;
    if (elapsed > (opts.slowThresholdMs ?? 3000)) evidence.event({ type: "detect", stepId: step.id, stepIndex: index, code: "SLOW_LOAD", kind: "recoverable", detail: `step took ${elapsed}ms (${waited.detail})` });

    // 5. expect
    // Never let a single assertion's poll window outlive the whole run's budget: three retries of a
    // long-timeout step would otherwise overshoot the deadline before anyone checks it again.
    const stepBudget = Math.max(500, Math.min(step.timeoutMs, state.deadline - Date.now()));
    for (const a of step.expect) {
      const v: Verdict = await waitForAssertion(a, surface, state.ctx, stepBudget, step.target, frame);
      evidence.event({ type: "verify", stepId: step.id, stepIndex: index, assertion: describeAssertion(a), ok: v.ok, observed: v.observed.slice(0, 200) });
      if (!v.ok) {
        const found = await classify(step, index);
        const next = await handleDetection(found, step, index, phase);
        if (next === "rerun") return runStep(step, index, phase, attempt);
        if (next === "reverify") {
          const again = await waitForAssertion(a, surface, state.ctx, stepBudget, step.target, frame);
          if (again.ok) continue;
        }
        if (isRetryable(step) && attempt < 3) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          return runStep(step, index, phase, attempt + 1);
        }
        await fail("CHECKPOINT_FAILED", step, v.expected, v.observed);
      }
    }
    if (step.pointOfNoReturn && state.sideEffects === "possible") state.sideEffects = "committed";

    // 6. steps without expectations cannot prove they succeeded: classify the resulting screen
    if (!step.expect.length && step.action !== "extract") {
      const found = await classify(step, index);
      if (found) {
        const next = await handleDetection(found, step, index, phase);
        if (next === "rerun") return runStep(step, index, phase, attempt);
      }
    }
    const shot = await surface.observe();
    state.lastScreenshot = evidence.screenshot(`${phase}-${step.id.replace("step:", "")}`, shot.rawScreenshotPng);
    state.stepsRun += 1;
  };

  // ---- run ----
  try {
    for (const c of opts.cookies ?? []) await surface.setCookie(c.url, c.name, c.value);
    const startIndex = opts.startAtStepIndex ?? 0;
    const firstStep = Object.values(cap.preludes)[0]?.[0] ?? cap.steps[0];
    if (startIndex === 0 && firstStep?.action !== "navigate") await surface.open(cap.policy.allowedOrigins[0]!);
    if (startIndex === 0) {
      for (const pre of cap.preconditions) {
        const name = pre.via.slice("prelude:".length);
        await runSequence(cap.preludes[name] ?? [], "prelude", 0, name);
      }
    }
    await runSequence(cap.steps, "main", startIndex);

    // final checkpoint
    for (const a of cap.checkpoint) {
      const v = await waitForAssertion(a, surface, state.ctx, 8000, undefined, cap.steps.at(-1)?.target?.frame);
      evidence.event({ type: "verify", assertion: `checkpoint ${describeAssertion(a)}`, ok: v.ok, observed: v.observed.slice(0, 200) });
      if (!v.ok) {
        const found = await classify(undefined, cap.steps.length);
        if (found?.outcome.kind === "business") business(found.outcome, undefined);
        await fail("FINAL_CHECKPOINT_FAILED", undefined, v.expected, v.observed);
      }
    }
    for (const [name, spec] of Object.entries(cap.outputs)) if (spec.required && !(name in state.outputs)) await fail("EXTRACTION_FAILED", undefined, `output ${name}`, "never extracted (its step did not run)");
    if (state.sideEffects === "possible") state.sideEffects = "committed";
    return finish({ status: "success", outputs: state.outputs, ...common(state) });
  } catch (e) {
    if (e instanceof Stop) return finish(e.result);
    evidence.event({ type: "error", code: "SURFACE_ERROR", message: (e as Error).message, ...((e as Error).stack ? { stack: (e as Error).stack! } : {}) });
    const bundle = await failureBundle("failure-unexpected").catch(() => ({}));
    return finish({ status: "failure", code: "SURFACE_ERROR", expected: "replay to run without engine errors", observed: (e as Error).message, evidence: bundle, ...common(state) });
  } finally {
    RUNNING.delete(pre.lockKey);
  }
}

function summaryOf(r: ReplayResult): string {
  switch (r.status) {
    case "success": return `success; outputs ${Object.keys(r.outputs).join(", ") || "none"}; side effects ${r.sideEffects}`;
    case "business_outcome": return `${r.code}: ${r.message}`;
    case "failure": return `${r.code} at ${r.atStep ?? "run"}: expected ${r.expected}; observed ${r.observed}`;
    case "escalated": return `${r.reason} at ${r.atStep ?? "run"}: ${r.detail}`;
  }
}

function suggestion(code: FailureCode, side: SideEffects): string {
  const retry = side === "none" ? "Safe to retry once the cause is fixed." : "Do NOT retry blindly: a side effect may have been committed. A human must check the account first.";
  switch (code) {
    case "WRONG_SCREEN": return `The app was not on the expected screen. Check for an interstitial or a changed navigation path; compare the failure screenshot with the recorded step. ${retry}`;
    case "LOCATOR_NOT_FOUND": return `No locator candidate matched. If the control moved or was relabelled, re-record this step or add a tenant overlay. ${retry}`;
    case "CHECKPOINT_FAILED": case "FINAL_CHECKPOINT_FAILED": return `The action ran but the expected state did not appear. Check the screenshot for an error banner the outcome catalog does not know yet. ${retry}`;
    case "UNKNOWN_DIALOG": return `An undeclared dialog blocked the run. If it is benign, declare it as a recoverable outcome (dismissDialog). ${retry}`;
    case "EXTRACTION_FAILED": return `The value could not be re-read. Check the table layout; add an extraction candidate. ${retry}`;
    case "RECOVERY_LOOP": return `A recovery kept re-triggering. The underlying condition is persistent; escalate to an operator. ${retry}`;
    case "UNSAFE_RESTART": return `A recoverable condition appeared after a point of no return, so the flow could not be restarted automatically. A human must check whether the committed action landed before anything is retried.`;
    default: return retry;
  }
}

export { EXIT_CODES };

/**
 * Recorder: action trace -> Capability artifact.
 *
 * - values typed by the agent become {param}/{secret} references (never literals for sensitive data)
 * - each step gets a screen-signature precondition from what was on screen before it
 * - each step gets an `expect` inferred from what changed after it
 * - login-like steps (those that typed a secret, through the following click) become the `login` prelude
 * - detours are pruned: if the flow returns to a screen it already visited, the loop is dropped
 * - outputs come from verified extraction candidates
 * - outcomes = vendor defaults + error states the agent reported
 */
import { CapabilitySchema, type Capability, type CapabilityInput, type ExtractionCandidate, type Landmark, type Outcome, type ScreenSignature, type Step, type StepInput, type Value } from "@cua/schema";
import type { ObservationSummary, Trace, TraceStep } from "../agent/loop.js";
import { isSensitiveName } from "../surface/playwright/perception.js";

export interface RecorderOptions {
  capabilityId: string;
  name: string;
  description?: string;
  vendor: string;
  variant?: string;
  allowedOrigins: string[];
  /** Input declarations; sensitivity defaults to pii. */
  inputs?: Record<string, { type?: "string" | "number" | "boolean"; description?: string; pattern?: string; sensitivity?: "none" | "pii" | "secret"; example?: string }>;
  defaultOutcomes?: Outcome[];
  provider: string;
  model: string;
  observedAppVersion?: string;
}

export interface RecorderResult {
  capability: Capability;
  prunedStepIds: string[];
  warnings: string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "step";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Placeholder for parameter positions while canonicalising a path; unlikely to appear in real URLs. */
const MARK = "\u2423";

/** URL of the content frame (deepest named frame), falling back to the top URL. */
function contentUrl(o: ObservationSummary): { path: string; frame: string[] } {
  const leaf = o.frames.filter((f) => f.path.length).at(-1);
  const url = leaf?.url ?? o.url;
  try {
    const u = new URL(url);
    return { path: u.pathname + u.search, frame: leaf?.path ?? [] };
  } catch {
    return { path: url, frame: leaf?.path ?? [] };
  }
}

/** Turn a concrete path into a pattern: parameter values -> `[^/?&]+`, long digit runs -> `\d+`. */
/** The model's tool names and the artifact's action names are not the same vocabulary. */
const ACTION_FOR_TOOL: Record<string, StepInput["action"]> = { dismiss_dialog: "dismissDialog" };

/** Tools that change the application rather than read it. */
const COMMITTING_TOOLS = new Set(["click", "press", "select", "type", "navigate", "dismiss_dialog"]);

export function canonicalizePath(path: string, paramValues: string[]): string {
  let p = path.split("?")[0]!;
  for (const v of paramValues.filter(Boolean).sort((a, b) => b.length - a.length)) p = p.split(v).join(MARK);
  p = escapeRe(p).split(MARK).join("[^/?&]+").replace(/\d{3,}/g, "\\d+");
  return `^${p}(\\?.*)?$`;
}

function sameFrame(frame: string[], other: string[]): boolean {
  return !frame.length || other.join("/") === frame.join("/");
}

/** A landmark name is unusable if it contains any parameter or secret value (it would leak into the artifact). */
function containsTaboo(name: string, taboo: string[]): boolean {
  return taboo.some((v) => v.length >= 2 && name.includes(v));
}

/** Free text written into the artifact (intents, descriptions) gets parameter values replaced by their placeholder and secrets by their name. */
function scrub(text: string, params: Record<string, string>, secrets: Record<string, string>): string {
  let out = text;
  const entries = [...Object.entries(params).map(([k, v]) => [v, `{${k}}`] as const), ...Object.entries(secrets).map(([k, v]) => [v, `{${k}}`] as const)]
    .filter(([v]) => v && v.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [v, ph] of entries) out = out.split(v).join(ph);
  return out;
}

/** Any string inside an extraction candidate that carries a parameter or secret value makes it unusable across invocations. */
function candidateHasTaboo(c: ExtractionCandidate, taboo: string[]): boolean {
  const strings: string[] = [];
  if (c.strategy === "tableCell") strings.push(c.rowMatch, c.columnHeader);
  else if (c.strategy === "cellRightOfLabel") strings.push(c.label);
  else if (c.strategy === "regexInRegion") strings.push(c.pattern);
  else strings.push(JSON.stringify(c.locator));
  return strings.some((s) => containsTaboo(s, taboo));
}

function signature(o: ObservationSummary, paramValues: string[], taboo: string[] = paramValues): ScreenSignature | undefined {
  const { path, frame } = contentUrl(o);
  const landmarks: Landmark[] = [];
  const seen = new Set<string>();
  const push = (role: string, name: string) => {
    if (!name || seen.has(`${role}:${name}`) || containsTaboo(name, taboo)) return;
    seen.add(`${role}:${name}`);
    landmarks.push({ role, name, exact: true });
  };
  for (const l of o.landmarks.filter((l) => sameFrame(frame, l.frame)).slice(0, 3)) push(l.role, l.name);
  for (const e of o.elements.filter((e) => sameFrame(frame, e.frame)).slice(0, 2)) push(e.role, e.name);
  if (!landmarks.length) return undefined;
  return { urlPattern: canonicalizePath(path, paramValues), frames: frame, landmarks, minLandmarks: Math.min(2, landmarks.length), negative: [] };
}

function stateKey(o: ObservationSummary, paramValues: string[], taboo: string[] = paramValues): string {
  const { path, frame } = contentUrl(o);
  const first = o.landmarks.find((l) => sameFrame(frame, l.frame) && !containsTaboo(l.name, taboo));
  return `${canonicalizePath(path, paramValues)}|${first?.name ?? ""}|${o.dialog ? "dialog" : ""}`;
}

function inferExpect(step: TraceStep, paramValues: string[], value?: Value, taboo: string[] = paramValues): Step["expect"] {
  const out: Step["expect"] = [];
  if (!step.after) return out;
  if ((step.decision.tool === "type" || step.decision.tool === "select") && value) {
    out.push({ kind: "valueEquals", value });
    return out;
  }
  const b = contentUrl(step.before);
  const a = contentUrl(step.after);
  if (a.path !== b.path) out.push({ kind: "urlMatches", pattern: canonicalizePath(a.path, paramValues), scope: "frame" });
  const beforeNames = new Set(step.before.landmarks.map((l) => `${l.role}:${l.name}`));
  const newLandmark = step.after.landmarks.find((l) => !beforeNames.has(`${l.role}:${l.name}`) && !containsTaboo(l.name, taboo));
  if (newLandmark) out.push({ kind: "landmarkVisible", landmark: { role: newLandmark.role, name: newLandmark.name, exact: true }, ...(a.frame.length ? { frame: a.frame } : {}) });
  else if (!out.length) {
    const beforeEls = new Set(step.before.elements.map((e) => `${e.role}:${e.name}`));
    const newEl = step.after.elements.find((e) => !beforeEls.has(`${e.role}:${e.name}`) && !containsTaboo(e.name, taboo));
    if (newEl) out.push({ kind: "landmarkVisible", landmark: { role: newEl.role, name: newEl.name, exact: true }, ...(newEl.frame.length ? { frame: newEl.frame } : {}) });
  }
  if (step.after.dialog) out.push({ kind: "dialogOpen", open: true });
  return out;
}

function inferWait(step: TraceStep, expect: Step["expect"]): Step["wait"] {
  if (!step.after || step.decision.tool === "type" || step.decision.tool === "select") return { for: "none" };
  const lm = expect.find((e) => e.kind === "landmarkVisible");
  if (lm && lm.kind === "landmarkVisible") return { for: "landmark", landmark: lm.landmark, ...(lm.frame ? { frame: lm.frame } : {}), timeoutMs: 8000 };
  if (contentUrl(step.before).path !== contentUrl(step.after).path) return { for: "urlChange", timeoutMs: 8000 };
  return { for: "load", timeoutMs: 8000 };
}

type Built = { step: StepInput; trace: TraceStep; key: string; usesSecret: boolean };

export function recordCapability(trace: Trace, secrets: Record<string, string>, opts: RecorderOptions): RecorderResult {
  const warnings: string[] = [];
  const paramValues = Object.values(trace.params).filter(Boolean);
  const taboo = [...paramValues, ...Object.values(secrets).filter(Boolean)];

  // inputs
  const inputs: NonNullable<CapabilityInput["inputs"]> = {};
  for (const [name, v] of Object.entries(trace.params)) {
    const decl = opts.inputs?.[name] ?? {};
    inputs[name] = {
      type: decl.type ?? "string",
      description: decl.description ?? `Parameter ${name}`,
      required: true,
      ...(decl.pattern ? { pattern: decl.pattern } : /^\d+$/.test(v) ? { pattern: `^\\d{${v.length}}$` } : {}),
      sensitivity: decl.sensitivity ?? "pii",
      ...(decl.example ? { example: decl.example } : {}),
    };
  }
  const secretNames = new Set<string>();
  const usedIds = new Set<string>();
  const uniqueId = (base: string) => {
    let id = `step:${base}`;
    let n = 2;
    while (usedIds.has(id)) id = `step:${base}-${n++}`;
    usedIds.add(id);
    return id;
  };
  const outputs: NonNullable<CapabilityInput["outputs"]> = {};

  // 1. successful actions -> steps
  const built: Built[] = [];
  for (const t of trace.steps) {
    const d = t.decision;
    if (!["click", "type", "select", "press", "navigate", "extract", "dismiss_dialog"].includes(d.tool)) continue;
    // Failed actions are not part of the successful path — except one that "failed" only by raising
    // a dialog, which is exactly how this application asks for its final confirmation.
    if (!t.actOk && !t.raisedDialog) continue;
    const el = t.element;
    let value: Value | undefined;
    let usesSecret = false;
    if (t.rawValue !== undefined && d.tool !== "extract") {
      // the placeholder the agent typed is authoritative; matching by value is the fallback
      const secretName = t.valueRef?.kind === "secret" ? t.valueRef.name : Object.entries(secrets).find(([, v]) => v && v === t.rawValue)?.[0];
      const paramName = t.valueRef?.kind === "param" ? t.valueRef.name : Object.entries(trace.params).find(([, v]) => v && v === t.rawValue)?.[0];
      if (d.tool === "type" && secretName) {
        value = { kind: "secret", name: secretName };
        secretNames.add(secretName);
        usesSecret = true;
      } else if (d.tool === "type" && paramName) {
        value = { kind: "param", name: paramName };
      } else if (d.tool === "type" && el && isSensitiveName(el.name)) {
        const name = `TYPED_SECRET_${t.index + 1}`;
        warnings.push(`step ${t.index + 1} typed a literal into sensitive field "${el.name}"; recorded as secret reference ${name}`);
        value = { kind: "secret", name };
        secretNames.add(name);
        usesSecret = true;
      } else {
        value = { kind: "literal", value: t.rawValue };
      }
    }

    // A modal dialog is not a screen. While one is open the page behind it is not reliably
    // readable — the accessibility snapshot still lists controls, but querying them is blocked — so
    // landmarks recorded here match nothing on replay and the step fails WRONG_SCREEN one action
    // short of the commit. Keep the URL and the frame, which stay readable and are what the
    // executor needs to aim its assertions at the content frame; drop the landmarks.
    // readable — the accessibility snapshot still lists controls, but querying them is blocked — so
    // landmarks recorded here match nothing on replay and the step fails WRONG_SCREEN one action
    // short of the commit. A signature must carry landmarks to be valid, so a dialog step records
    // none at all; the executor takes its frame from the step that raised the dialog instead.
    const precondition = d.tool === "dismiss_dialog" ? undefined : signature(t.before, paramValues, taboo);
    const expect = inferExpect(t, paramValues, value, taboo);
    const idBase = d.tool === "extract" ? `extract-${String(d.args["output"])}` : d.tool === "dismiss_dialog" ? `${t.rawValue === "accept" ? "accept" : "cancel"}-dialog` : `${d.tool}-${el ? `${el.role}-${el.name}` : d.tool}`;
    const step: StepInput = {
      id: uniqueId(slug(idBase)),
      intent: scrub((d.reasoning || `${d.tool} ${el?.name ?? ""}`).replace(/\s+/g, " ").trim().slice(0, 160), trace.params, secrets),
      action: ACTION_FOR_TOOL[d.tool] ?? (d.tool as StepInput["action"]),
      ...(t.locator ? { target: t.locator } : {}),
      ...(value ? { value } : {}),
      ...(precondition ? { precondition } : {}),
      expect,
      wait: inferWait(t, expect),
      risk: t.verdict.risk,
      // Any risky action that actually acts commits something; restricting this to `click` meant the
      // G2 flow — whose point of no return is accepting a confirm dialog — recorded no
      // pointOfNoReturn at all, and so replayed with sideEffects stuck at "possible".
      ...(t.verdict.risk === "risky" && COMMITTING_TOOLS.has(d.tool) ? { pointOfNoReturn: true } : {}),
    };

    if (d.tool === "extract") {
      const clean = (t.extract?.verified ?? []).filter((c) => !candidateHasTaboo(c, taboo));
      if (!t.extract || !clean.length) {
        warnings.push(`extract ${String(d.args["output"])}: no verified extraction strategy free of parameter/secret values; skipped`);
        continue;
      }
      const { output, value: raw, description } = t.extract;
      const verified = clean;
      if (outputs[output]) continue; // the first successful extract of an output wins; later repeats are no-ops
      const first = verified[0]!;
      const frame = "frame" in first && first.frame ? first.frame : [];
      step.output = output;
      step.target = t.locator ?? { frame, candidates: [{ strategy: "css", selector: "table td", confidence: 0.2 }], rationale: "Informational only: extraction uses the output's own candidates, most semantic first." };
      step.wait = { for: "none" };
      step.expect = [];
      const money = /^-?\$?[\d,]+\.\d{2}$/.test(raw);
      const num = !money && /^-?[\d,]+(\.\d+)?$/.test(raw);
      const type = money ? "money" : num ? "number" : "string";
      outputs[output] = {
        type,
        description: scrub(description || `Value read from the screen for ${output}`, trace.params, secrets),
        from: step.id,
        required: true,
        extract: {
          candidates: verified as ExtractionCandidate[],
          parse: type === "money" ? { kind: "money", locale: "en-US", currency: "USD" } : type === "number" ? { kind: "number", locale: "en-US" } : { kind: "string", trim: true },
          ...(type === "money" ? { validate: { min: 0 } } : {}),
        },
      };
    }
    built.push({ step, trace: t, key: t.after ? stateKey(t.after, paramValues, taboo) : "", usesSecret });
  }

  // 2. prune detours: returning to an already-seen screen drops the loop in between, unless the
  //    loop contains data entry or extraction (those are never detours). Also drop no-op clicks.
  const kept: Built[] = [];
  const pruned: string[] = [];
  const startKey = trace.steps[0] ? stateKey(trace.steps[0].before, paramValues, taboo) : "";
  const seenAt = new Map<string, number>([[startKey, -1]]);
  for (const b of built) {
    const prev = seenAt.get(b.key);
    if (b.key && prev !== undefined && prev < kept.length) {
      const loop = kept.slice(prev + 1).concat(b);
      const safeToPrune = loop.every((x) => x.step.action === "click" || x.step.action === "navigate" || x.step.action === "press");
      if (safeToPrune) {
        for (const x of loop) pruned.push(x.step.id);
        kept.length = prev + 1;
        continue;
      }
    }
    const noop = (b.step.action === "click" || b.step.action === "navigate") && b.trace.after && stateKey(b.trace.before, paramValues, taboo) === b.key && !b.trace.after.dialog;
    if (noop) {
      pruned.push(b.step.id);
      continue;
    }
    kept.push(b);
    seenAt.set(b.key, kept.length - 1);
  }

  // 3. prelude split: through the first click/press after the last secret typed
  let preludeEnd = -1;
  const lastSecret = kept.map((k) => k.usesSecret).lastIndexOf(true);
  if (lastSecret >= 0) {
    const submit = kept.findIndex((k, i) => i > lastSecret && (k.step.action === "click" || k.step.action === "press"));
    preludeEnd = submit >= 0 ? submit : lastSecret;
  }
  const preludeSteps = preludeEnd >= 0 ? kept.slice(0, preludeEnd + 1) : [];
  let mainSteps = preludeEnd >= 0 ? kept.slice(preludeEnd + 1) : kept;
  if (preludeSteps.length && !preludeSteps.some((s) => s.step.action === "navigate")) {
    const firstSig = preludeSteps[0]!.step.precondition;
    const lm = firstSig?.landmarks[0];
    preludeSteps.unshift({
      step: {
        id: uniqueId("open-app"), intent: "Open the application", action: "navigate", value: { kind: "literal", value: trace.startUrl },
        expect: lm ? [{ kind: "landmarkVisible", landmark: lm, ...(firstSig?.frames?.length ? { frame: firstSig.frames } : {}) }] : [],
        wait: { for: "load", timeoutMs: 8000 }, risk: "safe",
      },
      trace: trace.steps[0]!, key: startKey, usesSecret: false,
    });
  }
  if (!mainSteps.length) {
    warnings.push("no main steps after prelude split; keeping prelude steps as the flow");
    mainSteps = preludeSteps.splice(0);
  }
  if (!mainSteps.length) throw new Error("recorder: trace contains no successful actions");

  // 4. checkpoint from the final screen
  const last = mainSteps.at(-1)!;
  const final = trace.final ?? last.trace.after ?? last.trace.before;
  const checkpoint: CapabilityInput["checkpoint"] = [];
  const sig = signature(final, paramValues, taboo);
  if (sig?.landmarks[0]) checkpoint.push({ kind: "landmarkVisible", landmark: sig.landmarks[0], ...(sig.frames.length ? { frame: sig.frames } : {}) });
  for (const [name, v] of Object.entries(trace.params)) if (v && final.text.includes(v)) checkpoint.push({ kind: "textVisible", value: { kind: "param", name }, ...(sig?.frames.length ? { frame: sig.frames } : {}) });
  if (!checkpoint.length && sig?.urlPattern) checkpoint.push({ kind: "urlMatches", pattern: sig.urlPattern, scope: "frame" });
  if (!checkpoint.length) checkpoint.push({ kind: "textVisible", pattern: escapeRe(final.title || "."), flags: "i" });

  // 5. outcomes: vendor defaults + error states the agent reported during the run
  const outcomes: Outcome[] = [...(opts.defaultOutcomes ?? [])];
  for (const t of trace.steps) {
    if (t.decision.tool !== "assert_state" || t.decision.args["kind"] !== "error_seen") continue;
    const detail = String(t.decision.args["detail"] ?? "").trim();
    if (detail.length < 4) continue;
    const code = `SEEN_${slug(detail).toUpperCase().replace(/-/g, "_").slice(0, 30)}`;
    if (outcomes.some((o) => o.code === code)) continue;
    const phrase = detail.split(/[.!?]/)[0]!.slice(0, 60);
    outcomes.push({ code, kind: "business", message: detail.slice(0, 200), detect: [{ kind: "textMatches", pattern: escapeRe(phrase), flags: "i" }], appliesTo: "any", maxRecoveries: 1, escalate: false });
  }

  const actions = new Set<StepInput["action"]>(["navigate", "click", "type", "extract"]);
  for (const s of [...preludeSteps, ...mainSteps]) actions.add(s.step.action);

  const now = new Date().toISOString();
  const input: CapabilityInput = {
    schemaVersion: "1.0",
    capability: {
      id: opts.capabilityId, version: 1, status: "draft", name: scrub(opts.name, trace.params, secrets),
      description: scrub(opts.description ?? trace.goal, trace.params, secrets),
      app: { vendor: opts.vendor, variant: opts.variant ?? "default", surface: "web", ...(opts.observedAppVersion ? { observedAppVersion: opts.observedAppVersion } : {}) },
      changelog: [{ version: 1, date: now, author: `recorder (${opts.provider}/${opts.model})`, note: scrub(`Recorded from run ${trace.runId}: ${trace.goal}`, trace.params, secrets) }],
    },
    requires: { surface: "web", secrets: [...secretNames].sort() },
    inputs,
    outputs,
    preconditions: preludeSteps.length ? [{ kind: "authenticated", via: "prelude:login" }] : [],
    preludes: preludeSteps.length ? { login: preludeSteps.map((s) => s.step) } : {},
    steps: mainSteps.map((s) => s.step),
    checkpoint,
    outcomes,
    policy: { allowedOrigins: opts.allowedOrigins, allowedActions: [...actions] },
    provenance: { discoveredAt: trace.startedAt, provider: opts.provider, model: opts.model, runId: trace.runId, redacted: true },
  };
  const parsed = CapabilitySchema.safeParse(input);
  if (!parsed.success) throw new Error(`recorder produced an invalid artifact:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return { capability: parsed.data, prunedStepIds: pruned, warnings };
}

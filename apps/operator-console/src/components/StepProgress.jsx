/**
 * A replay, step by step, as it happens.
 *
 * Derived entirely from the event stream rather than from a second source of truth: each step's
 * verdict is whatever its own events said. A step is pending until something happens to it, then
 * running, then passed, recovered or failed. The point of showing it is that "deterministic replay"
 * is otherwise invisible — it finishes in two seconds and the only evidence is a number.
 */
import { useMemo } from "react";

const ICON = { passed: "✓", failed: "✗", recovered: "↻", running: "•", pending: "·" };

/**
 * The run's steps, derived entirely from its event stream rather than from a second source of
 * truth: each step's verdict is whatever its own events said. Exported for its own tests, because
 * this is the part of the console that changes when the engine's event shape does.
 */
export function buildSteps(events) {
  const order = [];
  const byId = new Map();
  const touch = (id, phase) => {
    if (!byId.has(id)) {
      const step = { id, phase, status: "running", notes: [] };
      byId.set(id, step);
      order.push(step);
    }
    const step = byId.get(id);
    // The engine tags each step event with the sequence it belongs to, so a prelude's steps are
    // distinguishable from the flow's own without the console guessing from the step id.
    if (phase && !step.phase) step.phase = phase;
    return step;
  };

  for (const e of events) {
    if (!e.stepId) {
      if (e.type === "recover" && !e.stepId) continue;
      continue;
    }
    const s = touch(e.stepId, e.phase);
    switch (e.type) {
      case "act":
        s.action = e.action;
        if (!e.ok) s.notes.push(`action failed: ${e.error ?? "unknown"}`);
        break;
      case "precondition":
        if (!e.ok) s.notes.push("precondition did not hold");
        break;
      case "verify":
        if (e.ok) s.status = s.status === "failed" ? "recovered" : "passed";
        else s.notes.push(`not confirmed: ${e.assertion}`);
        break;
      case "extract":
        s.status = "passed";
        s.notes.push(`read ${e.output} = ${JSON.stringify(e.parsed)}`);
        break;
      case "detect":
        s.notes.push(`${e.code} (${e.kind})`);
        if (e.kind === "failure") s.status = "failed";
        break;
      case "recover":
        s.status = "recovered";
        s.notes.push(`recovered via ${e.recovery}`);
        break;
      case "drift":
        s.notes.push(`drift: ${e.primaryStrategy} → ${e.matchedStrategy}`);
        break;
      case "escalate":
        s.status = "failed";
        s.notes.push(`escalated: ${e.reason}`);
        break;
      default:
        break;
    }
  }
  return order;
}

export default function StepProgress({ events, result }) {
  const steps = useMemo(() => buildSteps(events), [events]);
  if (!steps.length) return null;

  return (
    <section className="steps">
      <header>
        <h3>Replay</h3>
        {result && (
          <span className="muted">
            {result.stepsRun} steps · {result.durationMs}ms · side effects {result.sideEffects}
          </span>
        )}
      </header>
      <ol className="steps__list">
        {steps.map((s) => (
          <li key={s.id} className={`step step--${s.status}`}>
            <span className="step__icon">{ICON[s.status]}</span>
            <span className="step__name">
              {s.phase === "prelude" && <em className="muted">prelude </em>}
              {s.action ?? "step"} <code>{s.id.replace("step:", "")}</code>
            </span>
            {s.notes.length > 0 && <span className="step__notes">{s.notes.join(" · ")}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

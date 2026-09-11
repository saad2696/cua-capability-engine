/**
 * The run's evidence log, grouped the way the run actually happens.
 *
 * A flat stream of thirty event types is unreadable at a glance, which defeats the purpose of
 * having it on screen during a demo. Events are bucketed by phase — what the engine saw, what it
 * decided, what it did, how control moved — so an observer can follow the shape of the run without
 * reading every line.
 */
import { useMemo, useState } from "react";

const PHASE = {
  observe: ["observe", "page_switch"],
  decide: ["decide", "assist"],
  act: ["act", "resolve", "press"],
  verify: ["precondition", "verify", "detect", "extract"],
  recover: ["recover", "drift", "visual_drift", "skipped_optional", "pruned"],
  control: ["control_change", "human_action", "escalate", "resume", "risk_flag", "policy_block", "policy_override"],
  run: ["run_started", "result", "error"],
};
const PHASE_OF = Object.fromEntries(Object.entries(PHASE).flatMap(([phase, types]) => types.map((t) => [t, phase])));
const PHASES = ["all", ...Object.keys(PHASE)];

/** One line per event, phrased for a person rather than echoing the JSON. */
function describe(e) {
  switch (e.type) {
    case "run_started": return `run started (${e.mode}) — ${e.capabilityId}`;
    case "observe": return `saw ${e.elementCount} interactive elements at ${e.url}`;
    case "decide": return `model chose ${e.tool}: ${e.reasoning ?? ""}`;
    case "act": return `${e.action}${e.target ? ` via ${e.target}` : ""}${e.value ? ` = ${e.value}` : ""}${e.ok ? "" : ` — failed: ${e.error ?? ""}`}`;
    case "resolve": return `matched by ${e.matchedStrategy}${e.candidateIndex > 0 ? ` (fallback #${e.candidateIndex})` : ""}`;
    case "precondition": return e.ok ? "on the expected screen" : `wrong screen — missing ${e.expectedLandmarks?.length ?? 0} landmark(s)`;
    case "verify": return `${e.ok ? "confirmed" : "not confirmed"}: ${e.assertion}`;
    case "detect": return `detected ${e.code} (${e.kind})${e.detail ? ` — ${e.detail}` : ""}`;
    case "recover": return `recovery ${e.recovery} for ${e.code}, attempt ${e.attempt}${e.ok ? "" : " — failed"}`;
    case "extract": return `read ${e.output} = ${JSON.stringify(e.parsed)} via ${e.strategy}`;
    case "drift": return `drift: recorded ${e.primaryStrategy}, matched ${e.matchedStrategy}`;
    case "visual_drift": return `the control moved (position match ${Math.round((e.similarity ?? 0) * 100)}%)`;
    case "escalate": return `escalated: ${e.reason} — ${e.detail ?? ""}`;
    case "control_change": return `control ${e.from} → ${e.to}${e.by ? ` (${e.by})` : ""}`;
    case "human_action": return `operator ${e.action}${e.value ? ` = ${e.value}` : ""}`;
    case "resume": return `handed back: ${e.resumeAt}${e.note ? ` — "${e.note}"` : ""}`;
    case "risk_flag": return `risky step allowed: ${e.action}`;
    case "policy_block": return `blocked by policy: ${e.detail ?? e.action}`;
    case "policy_override": return `policy overridden by ${e.by}: ${e.reason}`;
    case "result": return `finished: ${e.summary}`;
    case "error": return `${e.code}: ${e.message}`;
    case "skipped_optional": return `skipped an optional step: ${e.reason}`;
    default: return e.type;
  }
}

export default function EventLog({ events }) {
  const [phase, setPhase] = useState("all");
  const shown = useMemo(
    () => (phase === "all" ? events : events.filter((e) => PHASE_OF[e.type] === phase)),
    [events, phase],
  );

  return (
    <section className="eventlog">
      <header>
        <h3>Activity</h3>
        <div className="eventlog__filters">
          {PHASES.map((p) => (
            <button key={p} className={phase === p ? "chip chip--on" : "chip"} onClick={() => setPhase(p)}>
              {p}
            </button>
          ))}
        </div>
      </header>
      <ol className="eventlog__list">
        {shown.map((e) => (
          <li key={`${e.seq}-${e.type}`} className={`ev ev--${PHASE_OF[e.type] ?? "other"}`}>
            <span className="ev__seq">{e.seq}</span>
            <span className="ev__type">{e.type}</span>
            <span className="ev__text">
              {describe(e)}
              {/* Redaction is visible on purpose: an observer should see that the pipeline removed
                  the value, not wonder whether it was ever there. */}
              {String(JSON.stringify(e)).includes("[redacted") && <span className="redacted" title="a parameter or secret was removed">redacted</span>}
            </span>
          </li>
        ))}
        {!shown.length && <li className="muted">Nothing in this phase yet.</li>}
      </ol>
    </section>
  );
}

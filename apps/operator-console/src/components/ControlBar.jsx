/**
 * Take control, hand back, abort — with the state machine's rules reflected in what is clickable.
 *
 * The three hand-back answers are not cosmetic. "Retry the step" re-verifies the step the engine
 * stopped at; "I did it myself" advances past it; "Abort" ends the run. They correspond exactly to
 * the resumeAt values the engine understands, and getting them wrong is how a committed action gets
 * performed twice.
 */
import { useState } from "react";

const RESUME_OPTIONS = [
  { value: "same", label: "Retry the step", hint: "The engine re-checks the step it stopped at" },
  { value: "next", label: "I did it myself", hint: "The engine skips that step and carries on" },
  { value: "abort", label: "Abort the run", hint: "Stop here; nothing further runs" },
];

export default function ControlBar({ run, intervention, controlled, connected, onClaim, onHandBack, onPause, onAbort, busy }) {
  const [resumeAt, setResumeAt] = useState("same");
  const [note, setNote] = useState("");
  const state = run?.session?.state ?? "idle";
  const finished = Boolean(run?.finishedAt);
  const canClaim = Boolean(intervention) && state === "paused" && connected && !controlled;
  const canPause = !finished && state === "running";

  return (
    <div className="controlbar">
      <div className="controlbar__id">
        <strong>{run?.capabilityId ?? "run"}</strong>
        <span className="muted">
          {run?.kind === "discover" ? "discovery" : `v${run?.capabilityVersion}`} · {run?.id}
        </span>
      </div>

      <div className="controlbar__state">
        <span className={`pill pill--${state}`}>{state.replace("_", " ")}</span>
        {run?.result && <span className={`pill pill--${run.result.status}`}>{run.result.status.replace("_", " ")}</span>}
        {run?.result?.sideEffects && run.result.sideEffects !== "none" && (
          <span className="pill pill--warn">side effects: {run.result.sideEffects}</span>
        )}
      </div>

      <div className="controlbar__actions">
        {!controlled ? (
          <>
            <button className="primary" disabled={!canClaim || busy} onClick={() => onClaim(intervention?.id)}>
              Take control
            </button>
            <button disabled={!canPause || busy} onClick={onPause} title="Stop the run between steps so you can look at it">
              Pause now
            </button>
          </>
        ) : (
          <>
            <select value={resumeAt} onChange={(e) => setResumeAt(e.target.value)} aria-label="How to hand back">
              {RESUME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input placeholder="note for the record (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="primary" disabled={busy} onClick={() => onHandBack(resumeAt, note, intervention?.id)}>
              Hand back
            </button>
          </>
        )}
        <button className="danger" disabled={finished || busy} onClick={onAbort}>
          Abort
        </button>
      </div>

      {controlled && <p className="controlbar__hint muted">{RESUME_OPTIONS.find((o) => o.value === resumeAt)?.hint}</p>}
    </div>
  );
}

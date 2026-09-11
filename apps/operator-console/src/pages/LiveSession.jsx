/**
 * One run, watched and steered.
 *
 * Layout follows what an operator actually needs in the order they need it: what is being asked of
 * them, then the browser itself, then what the run has been doing. The scenario panel sits beside it
 * because during a demonstration "make it fail now" is a first-class action, not a debugging aside.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import ArtifactBuilding from "../components/ArtifactBuilding.jsx";
import ControlBar from "../components/ControlBar.jsx";
import EventLog from "../components/EventLog.jsx";
import EvidencePanel from "../components/EvidencePanel.jsx";
import LiveViewport from "../components/LiveViewport.jsx";
import ScenarioPanel from "../components/ScenarioPanel.jsx";
import StepProgress from "../components/StepProgress.jsx";
import { useLiveSession, useRun } from "../hooks.js";
import { Link } from "../router.jsx";

export default function LiveSession({ runId, demo, onError }) {
  const { run, events, openIntervention } = useRun(runId);
  const { frame, connected, controlled, error: liveError, claim, handBack, send, clearError } = useLiveSession(runId);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState("");

  useEffect(() => {
    if (liveError) {
      onError(liveError);
      clearError();
    }
  }, [liveError, onError, clearError]);

  const guard = (fn) => async (...args) => {
    setBusy(true);
    try {
      await fn(...args);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const inject = guard(async (fault, sticky) => {
    await api.scenario(runId, fault, sticky);
    setArmed(`${fault}${sticky ? " (every request)" : " (next request)"}`);
  });
  const pause = guard(() => api.pause(runId, "operator-1"));
  const abort = guard(() => api.abort(runId));

  const finished = Boolean(run?.finishedAt);
  const controller = run?.session?.controller;

  // The newest screenshot the engine saved, served from the run's evidence directory. This is what
  // fills the viewport while the engine is driving and the live stream is intentionally unhurried.
  const stepFrame = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e.type === "observe" && e.screenshot) {
        return { src: `/api/runs/${runId}/evidence/${e.screenshot}`, url: e.url, stepId: e.stepId };
      }
    }
    return undefined;
  }, [events, runId]);

  return (
    <div className="live">
      <ControlBar
        run={run}
        intervention={openIntervention}
        controlled={controlled}
        connected={connected}
        busy={busy}
        onClaim={(id) => claim(id)}
        onHandBack={(resumeAt, note, id) => handBack(resumeAt, note, id)}
        onPause={pause}
        onAbort={abort}
      />

      {openIntervention && (
        <div className={`ask ask--${openIntervention.status}`}>
          <div>
            <strong>The engine stopped and is asking for a person.</strong>{" "}
            <span className="muted">
              {openIntervention.kind.replace("_", " ")} at {openIntervention.stepId ?? "the run"}
            </span>
            <p>{openIntervention.detail}</p>
          </div>
          {openIntervention.status === "claimed" && !controlled && (
            // Claimed by somebody else, or over HTTP from another tab: say so rather than offering a
            // button that will come back 409.
            <p className="muted">Claimed by {openIntervention.claimedBy ?? "another operator"}.</p>
          )}
        </div>
      )}

      <div className="live__body">
        <div className="live__main">
          {/* Side by side on a wide screen: the application on the left, what the engine is doing to
              it on the right. Watching one without the other is how a demonstration loses people. */}
          <div className="live__pair">
          <LiveViewport
            frame={frame}
            stepFrame={stepFrame}
            connected={connected}
            controller={controller}
            controlled={controlled}
            dialog={frame?.dialog}
            onInput={send}
          />
          {run?.kind === "discover" ? <ArtifactBuilding events={events} run={run} /> : <StepProgress events={events} result={run?.result} />}
          </div>
          <EventLog events={events} />
          <EvidencePanel runId={runId} />
        </div>

        <aside className="live__side">
          <ScenarioPanel
            faults={demo?.faults ?? []}
            onInject={inject}
            onPause={pause}
            disabled={finished}
            armed={armed}
            busy={busy}
          />

          {run?.result && (
            <section className="outcome">
              <h3>Outcome</h3>
              <p className={`pill pill--${run.result.status}`}>{run.result.status.replace("_", " ")}</p>
              {run.result.outputs && (
                <ul>
                  {Object.entries(run.result.outputs).map(([k, v]) => (
                    <li key={k}>
                      <code>{k}</code> = {JSON.stringify(v)}
                    </li>
                  ))}
                </ul>
              )}
              {run.result.code && <p className="muted">{run.result.code}</p>}
              {run.result.message && <p>{run.result.message}</p>}
              {run.result.expected && (
                <p className="muted">
                  expected {run.result.expected}; observed {run.result.observed}
                </p>
              )}
              {run.result.recoveries?.length > 0 && (
                <p className="muted">recovered: {run.result.recoveries.map((r) => `${r.code} via ${r.recovery}`).join(", ")}</p>
              )}
              <p className="muted">
                evidence <code>{run.evidenceDir}</code>
              </p>
            </section>
          )}

          {run?.session?.handoffs?.length > 0 && (
            <section className="handoffs">
              <h3>Handovers</h3>
              <ul>
                {run.session.handoffs.map((h, i) => (
                  <li key={i}>
                    {h.from} → {h.to} · {Math.round(h.durationMs / 1000)}s · {h.actions} action(s) · {h.resumeAt}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="muted">
            <Link to="/">Start another run</Link> · <Link to="/runs">All runs</Link>
          </p>
        </aside>
      </div>
    </div>
  );
}

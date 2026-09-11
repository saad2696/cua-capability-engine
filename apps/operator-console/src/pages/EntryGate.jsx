/**
 * The front door: point at a portal, pick what to do, start.
 *
 * Two deliberate constraints, both of which are the point rather than a limitation.
 *
 * Discovery takes any URL, because discovery is how a capability learns which application it
 * belongs to. Replay does not: a capability artifact carries the origins it was recorded against,
 * and pre-flight refuses anything else. So for replay the gate offers those origins instead of a
 * free-text box — pointing a recorded flow at a different origin is precisely what the policy
 * exists to prevent, and letting a text field override it would make the guarantee cosmetic.
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { go } from "../router.jsx";

export default function EntryGate({ demo, onError }) {
  const [mode, setMode] = useState("replay");
  const [url, setUrl] = useState("");
  const [goalKey, setGoalKey] = useState("G1");
  const [file, setFile] = useState("");
  const [params, setParams] = useState({});
  const [provider, setProvider] = useState("fake");
  const [fault, setFault] = useState("");
  const [pauseAtStart, setPauseAtStart] = useState(false);
  const [pace, setPace] = useState(0);
  const [busy, setBusy] = useState(false);

  const goal = demo?.goals.find((g) => g.key === goalKey);
  const artifact = demo?.artifacts.find((a) => a.file === file);

  useEffect(() => {
    if (!demo) return;
    setUrl(demo.portalUrl);
    const approvedFirst = [...demo.artifacts].sort((a, b) => (a.status === "approved" ? -1 : 1) - (b.status === "approved" ? -1 : 1) || b.version - a.version);
    setFile(approvedFirst[0]?.file ?? "");
  }, [demo]);

  useEffect(() => {
    if (mode === "discover" && goal) setParams({ ...goal.params });
  }, [mode, goalKey, goal]);

  useEffect(() => {
    if (mode !== "replay" || !artifact) return;
    // Pre-fill from each input's declared example, so the gate is usable without reading the artifact.
    setParams(Object.fromEntries(Object.entries(artifact.inputs).map(([k, spec]) => [k, spec.example ?? ""])));
  }, [mode, file, artifact]);

  // Required inputs with nothing in them. Checked here so the gate does not start a run that
  // pre-flight would refuse with INVALID_INPUT.
  const missing =
    mode === "replay" && artifact
      ? Object.entries(artifact.inputs)
          .filter(([k, spec]) => spec.required && !params[k])
          .map(([k]) => k)
      : [];

  const start = async () => {
    setBusy(true);
    try {
      const run =
        mode === "discover"
          ? await api.startDiscovery({ goal: goal.goal, url, capabilityId: goal.capabilityId, params, provider: provider === "fake" ? "fake" : undefined, maxSteps: 24 })
          : await api.startReplay({ artifactPath: file, params, pauseAtStart, ...(pace ? { stepDelayMs: pace } : {}), ...(fault ? { fault: { name: fault } } : {}) });
      go(`/runs/${run.id}`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!demo) return <p className="muted">Connecting to the engine…</p>;

  return (
    <div className="gate">
      <header className="gate__head">
        <h2>Run something</h2>
        <p className="muted">
          The engine works a task out once with a model, keeps it as a typed capability, then replays it with no model
          at all. Start either half here.
        </p>
      </header>

      <div className="gate__modes">
        <button className={mode === "replay" ? "tab tab--on" : "tab"} onClick={() => setMode("replay")}>
          Replay a capability
          <small>deterministic, no model, seconds</small>
        </button>
        <button className={mode === "discover" ? "tab tab--on" : "tab"} onClick={() => setMode("discover")}>
          Discover with a model
          <small>works out the flow and records it</small>
        </button>
      </div>

      <div className="gate__form">
        {mode === "discover" ? (
          <>
            <label>
              Portal URL
              <input value={url} onChange={(e) => setUrl(e.target.value)} />
              <small className="muted">Discovery may point anywhere allowlisted; it is how a capability finds its application.</small>
            </label>

            <label>
              Goal
              <select value={goalKey} onChange={(e) => setGoalKey(e.target.value)}>
                {demo.goals.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.key} — {g.title} ({g.risk})
                  </option>
                ))}
              </select>
              <small className="muted">{goal?.goal}</small>
            </label>

            <label>
              Model
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {demo.providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Capability
              <select value={file} onChange={(e) => setFile(e.target.value)}>
                {demo.artifacts.map((a) => (
                  <option key={a.file} value={a.file}>
                    {a.id}@{a.version} — {a.status}
                  </option>
                ))}
              </select>
              <small className="muted">{artifact?.name}</small>
            </label>

            <label>
              Target
              <select value={url} onChange={(e) => setUrl(e.target.value)}>
                {(artifact?.allowedOrigins ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              <small className="muted">
                Only the origins this capability was recorded against. A different origin is a different tenant, which is
                an artifact overlay rather than a text field.
              </small>
            </label>

            <label>
              Pace
              <select value={pace} onChange={(e) => setPace(Number(e.target.value))}>
                <option value={0}>Full speed — about two seconds</option>
                <option value={700}>Watchable — a beat between steps</option>
                <option value={1800}>Slow — narrate each step</option>
              </select>
              <small className="muted">
                A deliberate wait after each step so the live view can be followed. It changes nothing about what the
                run does, and the wait is excluded from the run&apos;s own time budget.
              </small>
            </label>

            <label className="check">
              <span>
                <input type="checkbox" checked={pauseAtStart} onChange={(e) => setPauseAtStart(e.target.checked)} />
                Stop before the first step so I can take control
              </span>
              <small className="muted">
                A read-only replay finishes in about two seconds, which is faster than anyone can press pause. This is
                also the cautious way to run a capability for the first time.
              </small>
            </label>

            <label>
              Break something (optional)
              <select value={fault} onChange={(e) => setFault(e.target.value)}>
                <option value="">nothing — run it clean</option>
                {demo.faults.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                  </option>
                ))}
              </select>
              <small className="muted">{demo.faults.find((f) => f.name === fault)?.expect ?? "You can also inject faults mid-run once it starts."}</small>
            </label>
          </>
        )}

        {Object.keys(params).length > 0 && (
          <fieldset className="gate__params">
            <legend>Parameters</legend>
            {Object.entries(params).map(([k, v]) => {
              const spec = mode === "replay" ? artifact?.inputs?.[k] : undefined;
              return (
                <label key={k}>
                  <span>
                    {k}
                    {spec?.required && <span className="muted"> · required</span>}
                  </span>
                  <input
                    value={v}
                    // The artifact declares a pattern; showing it beats an empty box, and the
                    // artifact's own `example` is documented as synthetic-only, so a real recorded
                    // value must not be used to pre-fill it.
                    placeholder={spec?.pattern ? `matching ${spec.pattern}` : ""}
                    aria-invalid={spec?.required && !v ? "true" : undefined}
                    onChange={(e) => setParams({ ...params, [k]: e.target.value })}
                  />
                  {spec?.description && <small className="muted">{spec.description}</small>}
                </label>
              );
            })}
            <small className="muted">
              Substituted at replay time. The model only ever sees placeholders, so these values reach neither the
              transcript nor the artifact.
            </small>
          </fieldset>
        )}

        {/* Starting a run that pre-flight will reject teaches the operator nothing, so the gate
            refuses first and says which field is missing. */}
        <button className="primary big" disabled={busy || (mode === "replay" && (!file || missing.length > 0))} onClick={start}>
          {busy ? "starting…" : mode === "discover" ? "Discover" : "Replay"}
        </button>
        {missing.length > 0 && <p className="muted">Fill in {missing.join(", ")} first.</p>}
      </div>
    </div>
  );
}

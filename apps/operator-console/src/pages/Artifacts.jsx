/**
 * The capability catalog, and the reviewable rendering of one.
 *
 * Approval is the gate that matters here: unattended replay refuses a draft, so this screen is
 * where "a model worked this out once" becomes "this may run without anybody watching". The viewer
 * therefore shows what a reviewer needs to make that call — what it touches, what it commits, how
 * each control will be found, and what it knows how to recover from.
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { usePolled } from "../hooks.js";

function Value({ value }) {
  if (!value) return null;
  if (value.kind === "literal") return <code>{value.value}</code>;
  // The two that matter: a reference means the value lives outside the artifact.
  return <code className="ref">{value.kind === "secret" ? `<secret ${value.name}>` : `{${value.name}}`}</code>;
}

function Step({ step, n }) {
  const primary = step.target?.candidates?.[0];
  const describe = (c) =>
    c.strategy === "role" ? `${c.role} "${c.name}"` : c.text ? `"${c.text}"` : c.selector ? c.selector : "visual";

  return (
    <li className="astep">
      <div className="astep__head">
        <span className="astep__n">{n}</span>
        <strong>{step.action}</strong>
        {primary && <span>{describe(primary)}</span>}
        <Value value={step.value} />
        {step.risk === "risky" && <span className="pill pill--warn">risky</span>}
        {step.pointOfNoReturn && <span className="pill pill--danger">point of no return</span>}
        {step.optional && <span className="pill">optional</span>}
      </div>
      <p className="muted">{step.intent}</p>
      {step.target?.candidates?.length > 1 && (
        <p className="muted">
          fallbacks: {step.target.candidates.slice(1).map((c) => c.strategy).join(" → ")}
          {step.target.rationale ? ` — ${step.target.rationale}` : ""}
        </p>
      )}
      {step.expect?.length > 0 && (
        <p className="muted">confirms: {step.expect.map((a) => a.kind).join(", ")}</p>
      )}
    </li>
  );
}

export default function Artifacts({ onError }) {
  const { value: list } = usePolled(api.artifacts, 5000);
  const [file, setFile] = useState("");
  const [cap, setCap] = useState();
  const [busy, setBusy] = useState(false);
  // Two-step rather than a browser confirm(): a native dialog would block the page, and this
  // console exists partly to demonstrate how badly one of those goes.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!file && list?.length) setFile(list[list.length - 1].file);
  }, [list, file]);

  useEffect(() => {
    if (file) api.artifact(file).then(setCap, (e) => onError(e.message));
  }, [file, onError]);

  const remove = async (force) => {
    setBusy(true);
    try {
      await api.deleteArtifact(file, force);
      setConfirming(false);
      setFile("");
      setCap(undefined);
      // The list polls, so it drops the row on its own within a few seconds.
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await api.approve(file, "operator-1");
      setCap(await api.artifact(file));
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!list) return <p className="muted">Loading…</p>;

  return (
    <div className="artifacts">
      <aside>
        <h3>Capabilities</h3>
        <ul className="artifacts__list">
          {list.map((a) => {
            // Two rows with the same name read as a duplicate when they are a version history, so
            // the older ones say so. Superseded is not the same as obsolete: an earlier version is
            // what a past run was recorded against, and its evidence still points at it.
            const superseded = list.some((b) => b.id === a.id && b.version > a.version);
            return (
              <li key={a.file} className={superseded ? "is-superseded" : undefined}>
                <button className={file === a.file ? "link link--on" : "link"} onClick={() => setFile(a.file)}>
                  {a.id} <span className="ver">v{a.version}</span>
                </button>
                <span className={`pill pill--${a.status}`}>{a.status}</span>
                {superseded && <span className="muted note-sup">superseded by v{Math.max(...list.filter((b) => b.id === a.id).map((b) => b.version))}</span>}
              </li>
            );
          })}
        </ul>
      </aside>

      {cap && (
        <article>
          <header>
            <h2>
              {cap.capability.id}@{cap.capability.version}{" "}
              <span className={`pill pill--${cap.capability.status}`}>{cap.capability.status}</span>
            </h2>
            <p>{cap.capability.name}</p>
            {cap.capability.status === "draft" && (
              <p className="approve">
                <button className="primary" disabled={busy} onClick={approve}>
                  Approve for unattended replay
                </button>
                <span className="muted">A draft can only be replayed with an explicit override.</span>
              </p>
            )}
            <p className="danger-row">
              {!confirming ? (
                <button className="link danger" disabled={busy} onClick={() => setConfirming(true)}>
                  Delete this capability
                </button>
              ) : (
                <>
                  <span className="muted">
                    Delete {file}? {cap.capability.status === "approved" ? "It is approved, and this cannot be undone here." : "This cannot be undone here."}
                  </span>{" "}
                  <button className="danger" disabled={busy} onClick={() => remove(cap.capability.status === "approved")}>
                    Yes, delete
                  </button>{" "}
                  <button className="link" disabled={busy} onClick={() => setConfirming(false)}>
                    cancel
                  </button>
                </>
              )}
            </p>

            {cap.provenance?.approvedBy && (
              <p className="muted">
                approved by {cap.provenance.approvedBy} at {cap.provenance.approvedAt}
              </p>
            )}
          </header>

          <section className="contract">
            <h3>Contract</h3>
            <p>
              <strong>in</strong>{" "}
              {Object.entries(cap.inputs).map(([k, v]) => (
                <code key={k}>
                  {k}:{v.type}
                  {v.required ? "" : "?"}
                </code>
              ))}
            </p>
            <p>
              <strong>out</strong>{" "}
              {Object.entries(cap.outputs).map(([k, v]) => (
                <code key={k}>
                  {k}:{v.type}
                </code>
              ))}
            </p>
            <p className="muted">
              secrets {cap.requires?.secrets?.join(", ") || "none"} · origins {cap.policy?.allowedOrigins?.join(", ")}
            </p>
          </section>

          {Object.entries(cap.preludes ?? {}).map(([name, steps]) => (
            <section key={name}>
              <h3>Prelude: {name}</h3>
              <p className="muted">Re-run on its own whenever the precondition it establishes is lost.</p>
              <ol className="asteps">
                {steps.map((s, i) => (
                  <Step key={s.id} step={s} n={i + 1} />
                ))}
              </ol>
            </section>
          ))}

          <section>
            <h3>Steps</h3>
            <ol className="asteps">
              {cap.steps.map((s, i) => (
                <Step key={s.id} step={s} n={i + 1} />
              ))}
            </ol>
          </section>

          <section>
            <h3>Outcomes it knows about</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Kind</th>
                  <th>Recovery</th>
                  <th>Means</th>
                </tr>
              </thead>
              <tbody>
                {cap.outcomes.map((o) => (
                  <tr key={o.code}>
                    <td>
                      <code>{o.code}</code>
                    </td>
                    <td>
                      <span className={`pill pill--${o.kind}`}>{o.kind}</span>
                    </td>
                    <td>{o.recover ?? (o.escalate ? "escalate" : "—")}</td>
                    <td>{o.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Provenance</h3>
            <p className="muted">
              discovered by {cap.provenance?.provider}/{cap.provenance?.model} at {cap.provenance?.discoveredAt} ·
              schema {cap.schemaVersion}
            </p>
          </section>
        </article>
      )}
    </div>
  );
}

/**
 * What the run left on disk, browsable.
 *
 * Evidence is the whole argument for trusting an unattended automation: the screenshots it acted
 * on, the structured log of every decision, the typed result, and for a failure a narrative naming
 * what it expected and what it saw. Leaving all that reachable only from a terminal path made the
 * most persuasive part of the system the least visible.
 */
import { useState } from "react";
import { api } from "../api.js";
import { usePolled } from "../hooks.js";

const size = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export default function EvidencePanel({ runId }) {
  const { value } = usePolled(() => api.evidence(runId), 4000, [runId]);
  const [open, setOpen] = useState();
  const [text, setText] = useState("");

  const show = async (file) => {
    setOpen(file);
    setText("");
    if (file.kind === "image" || file.kind === "trace") return;
    try {
      const res = await fetch(api.evidenceFile(runId, file.path));
      // A long event log is unreadable in full; the tail is the part anybody wants.
      const body = await res.text();
      setText(body.length > 20000 ? `… showing the last 20 KB of ${size(body.length)}\n\n${body.slice(-20000)}` : body);
    } catch (e) {
      setText(String(e));
    }
  };

  if (!value) return null;

  return (
    <section className="evidence">
      <header>
        <h3>Evidence</h3>
        <span className="muted">{value.files.length} file(s)</span>
      </header>
      <p className="muted">
        <code>{value.dir}</code>
      </p>

      <ul className="evidence__files">
        {value.files.map((f) => (
          <li key={f.path}>
            <button className={open?.path === f.path ? "link link--on" : "link"} onClick={() => show(f)}>
              {f.path}
            </button>
            <span className="muted">
              {f.kind} · {size(f.bytes)}
            </span>
          </li>
        ))}
        {!value.files.length && <li className="muted">Nothing written yet.</li>}
      </ul>

      {open && (
        <div className="evidence__view">
          {open.kind === "image" ? (
            <img src={api.evidenceFile(runId, open.path)} alt={open.path} />
          ) : open.kind === "trace" ? (
            <p className="muted">
              A Playwright trace. Download it and open with <code>npx playwright show-trace</code>.{" "}
              <a href={api.evidenceFile(runId, open.path)}>{open.path}</a>
            </p>
          ) : (
            <pre>{text || "loading…"}</pre>
          )}
        </div>
      )}
    </section>
  );
}

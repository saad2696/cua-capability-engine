/**
 * What the run left on disk, browsable.
 *
 * Evidence is the whole argument for trusting an unattended automation: the screenshots it acted
 * on, the structured log of every decision, the typed result, and for a failure a narrative naming
 * what it expected and what it saw. Leaving all that reachable only from a terminal path made the
 * most persuasive part of the system the least visible.
 *
 * Screenshots open in an overlay rather than inline. A step screenshot is a full 1280px page, so
 * rendering it in the flow of the list shoved everything else off the screen and read as a bug.
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { usePolled } from "../hooks.js";

const size = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function Lightbox({ runId, files, index, onClose, onIndex }) {
  const file = files[index];

  // Escape closes, arrows step through. A run has a screenshot per step, so stepping through them
  // in order is a flip-book of everything the engine did.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex(Math.min(index + 1, files.length - 1));
      if (e.key === "ArrowLeft") onIndex(Math.max(index - 1, 0));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [index, files.length, onClose, onIndex]);

  if (!file) return null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={file.path}>
      <div className="lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <strong>{file.path}</strong>
        <span className="muted">
          {index + 1} of {files.length} · {size(file.bytes)}
        </span>
        <span className="lightbox__actions">
          <button disabled={index === 0} onClick={() => onIndex(index - 1)}>
            ‹ previous
          </button>
          <button disabled={index === files.length - 1} onClick={() => onIndex(index + 1)}>
            next ›
          </button>
          <a href={api.evidenceFile(runId, file.path)} target="_blank" rel="noreferrer">
            open full size
          </a>
          <button onClick={onClose}>close</button>
        </span>
      </div>
      {/* Stop propagation so clicking the picture itself does not dismiss it. */}
      <img src={api.evidenceFile(runId, file.path)} alt={file.path} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

export default function EvidencePanel({ runId }) {
  const { value } = usePolled(() => api.evidence(runId), 4000, [runId]);
  const [shot, setShot] = useState(-1);
  const [open, setOpen] = useState();
  const [text, setText] = useState("");

  const images = (value?.files ?? []).filter((f) => f.kind === "image");

  const show = async (file) => {
    if (file.kind === "image") return setShot(images.findIndex((i) => i.path === file.path));
    setOpen(file);
    setText("");
    if (file.kind === "trace") return;
    try {
      const res = await fetch(api.evidenceFile(runId, file.path));
      const body = await res.text();
      // A long event log is unreadable in full; the tail is the part anybody wants.
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
        <span className="muted">
          {value.files.length} file(s)
          {images.length > 0 && (
            <>
              {" · "}
              <button className="link" onClick={() => setShot(0)}>
                step through {images.length} screenshots
              </button>
            </>
          )}
        </span>
      </header>
      <p className="muted">
        <code>{value.dir}</code>
      </p>

      <ul className="evidence__files">
        {value.files.map((f) => (
          <li key={f.path}>
            <button className={open?.path === f.path ? "link link--on" : "link"} onClick={() => show(f)}>
              {f.kind === "image" && (
                <img className="evidence__thumb" src={api.evidenceFile(runId, f.path)} alt="" loading="lazy" />
              )}
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
          <p className="muted">
            <strong>{open.path}</strong>{" "}
            <a href={api.evidenceFile(runId, open.path)} target="_blank" rel="noreferrer">
              open raw
            </a>
          </p>
          {open.kind === "trace" ? (
            <p className="muted">
              A Playwright trace. Download it and open with <code>npx playwright show-trace</code>.
            </p>
          ) : (
            <pre>{text || "loading…"}</pre>
          )}
        </div>
      )}

      {shot >= 0 && <Lightbox runId={runId} files={images} index={shot} onClose={() => setShot(-1)} onIndex={setShot} />}
    </section>
  );
}

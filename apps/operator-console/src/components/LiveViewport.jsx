/**
 * The automation's own browser, streamed as frames, and the surface an operator clicks into.
 *
 * Two things here are load-bearing. The border says who is driving, because the single most
 * dangerous confusion in a shared session is thinking you have control when you do not. And the
 * coordinate conversion happens in exactly one place: the image is rendered at whatever width the
 * layout gives it, so a click at CSS pixel x means page pixel x * (natural width / rendered width).
 * Every coordinate bug in this project has come from that factor being applied twice.
 */
import { useCallback, useRef } from "react";

const CONTROLLER_LABEL = {
  none: "nobody is driving",
  agent: "the model is driving",
  replay: "replay is driving",
  human: "you are driving",
};

/**
 * CSS pixels within the rendered image → page pixels in the live browser.
 *
 * Exported and pure so it can be tested directly. The image is rendered at whatever width the
 * layout gives it, so a click at CSS pixel x means page pixel x * (natural width / rendered width).
 * `naturalWidth` is 0 until the first frame arrives; scaling by zero would send every click to the
 * origin, so an unloaded image maps one to one instead.
 */
export function toPageCoordinates(point, rect, naturalWidth) {
  const scale = naturalWidth && rect.width ? naturalWidth / rect.width : 1;
  return { x: Math.round((point.clientX - rect.left) * scale), y: Math.round((point.clientY - rect.top) * scale) };
}

export default function LiveViewport({ frame, controller, controlled, onInput, dialog, stepFrame, connected }) {
  const imgRef = useRef(null);
  // Prefer the live stream. When it has not produced a frame yet, fall back to the screenshot the
  // engine saved on its last step: already on disk, costs the browser nothing, and it is literally
  // the picture the engine acted on.
  const src = frame?.png ? `data:image/png;base64,${frame.png}` : stepFrame?.src;
  const label = frame?.png ? "live" : stepFrame ? `step ${stepFrame.stepId?.replace("step:", "") ?? ""}` : "";

  const toPage = useCallback((e) => {
    const img = imgRef.current;
    if (!img) return null;
    return toPageCoordinates(e, img.getBoundingClientRect(), img.naturalWidth);
  }, []);

  const handleClick = (e) => {
    if (!controlled) return;
    const p = toPage(e);
    if (p) onInput({ type: "mouse", op: "click", ...p });
  };

  const handleKey = (e) => {
    if (!controlled) return;
    // Printable characters are typed into whatever has focus in the live page; named keys are sent
    // as key presses so Tab, Enter and Escape mean what the application expects.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      onInput({ type: "key", op: "type", text: e.key });
    } else if (["Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      onInput({ type: "key", op: "press", key: e.key });
    }
    // Escape deliberately does nothing: it releases focus in the browser, and an operator pressing
    // it to "get out" of the viewport must not also send it to a form they were halfway through.
  };

  const handleWheel = (e) => {
    if (!controlled) return;
    e.preventDefault();
    onInput({ type: "scroll", dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  };

  return (
    <div className={`viewport viewport--${controller ?? "none"}`}>
      <div className="viewport__bar">
        <span className={`badge badge--${controller ?? "none"}`}>{CONTROLLER_LABEL[controller ?? "none"]}</span>
        {label && <span className={`tick tick--${frame?.png ? "live" : "step"}`}>{label}</span>}
        <span className="viewport__url">{frame?.url ?? stepFrame?.url ?? (connected ? "waiting for a frame" : "not connected")}</span>
      </div>

      {dialog && (
        <div className="dialogbanner">
          <strong>{dialog.type}</strong> {dialog.message}
          {controlled ? (
            <span className="dialogbanner__actions">
              <button onClick={() => onInput({ type: "dialog", accept: true })}>Accept</button>
              <button onClick={() => onInput({ type: "dialog", accept: false })}>Dismiss</button>
            </span>
          ) : (
            <em> — take control to answer it</em>
          )}
        </div>
      )}

      <div
        className={`viewport__stage ${controlled ? "viewport__stage--live" : ""}`}
        tabIndex={controlled ? 0 : -1}
        onKeyDown={handleKey}
        onWheel={handleWheel}
        role={controlled ? "application" : undefined}
        aria-label={controlled ? "Live browser, your input goes here" : undefined}
      >
        {src ? (
          <img ref={imgRef} src={src} alt="the automation's browser" onClick={handleClick} draggable={false} />
        ) : (
          <div className="viewport__empty">
            <p>Nothing to show yet.</p>
            <p className="muted">
              The first frame arrives once the run has opened the application. A finished run keeps its last step
              screenshot in its evidence directory.
            </p>
          </div>
        )}
      </div>

      {controlled && <p className="hint">Click, type and scroll here. Everything you do lands in the automation&apos;s own browser and is recorded.</p>}
    </div>
  );
}

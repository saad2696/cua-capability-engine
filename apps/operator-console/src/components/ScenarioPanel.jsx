/**
 * The sandbox controls: make something go wrong on purpose, in a run that is already going.
 *
 * These arm faults inside the live browser's own cookie jar, so the *next* thing the running flow
 * does hits them. That is the difference between demonstrating recovery and demonstrating a
 * re-run with different flags — the automation has no idea anything changed.
 */
export default function ScenarioPanel({ faults, onInject, onPause, disabled, armed, busy }) {
  return (
    <section className="scenarios">
      <header>
        <h3>Break something</h3>
        <p className="muted">Armed inside the running browser. The flow hits it on its next request.</p>
      </header>

      <ul className="scenarios__list">
        {faults.map((f) => (
          <li key={f.name} className={f.escalates ? "scenario scenario--escalates" : "scenario"}>
            <button disabled={disabled || busy} onClick={() => onInject(f.name, false)} title={f.expect}>
              {f.label}
            </button>
            {/* Sticky makes the fault permanent, which is how a recoverable condition becomes a
                RECOVERY_LOOP: the same detection, but the condition never clears. */}
            <button className="link" disabled={disabled || busy} onClick={() => onInject(f.name, true)} title="Every request, not just the next one">
              keep failing
            </button>
            <span className="muted">{f.expect}</span>
          </li>
        ))}
      </ul>
      {/* Worth saying once: the panel contains two different kinds of thing. */}
      <p className="muted scenarios__legend">
        Most of these the engine handles by itself. The highlighted one it cannot, so it stops and hands you the
        browser.
      </p>

      <div className="scenarios__human">
        <button disabled={disabled || busy} onClick={onPause}>
          Force a human intervention
        </button>
        <span className="muted">Stops the run between steps with nothing wrong, so you can take over.</span>
      </div>

      {armed && <p className="armed">armed: {armed}</p>}
      {disabled && <p className="muted">Available while a run is in flight.</p>}
    </section>
  );
}

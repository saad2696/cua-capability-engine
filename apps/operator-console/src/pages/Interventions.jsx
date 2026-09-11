/**
 * The inbox: runs that have stopped and are waiting for somebody.
 *
 * Age is the column that matters. An intervention nobody answers expires and aborts its run, so a
 * queue that shows only "open" without showing how long it has been open hides the thing an
 * operator is deciding between.
 */
import { api } from "../api.js";
import { usePolled } from "../hooks.js";
import { Link, go } from "../router.jsx";

const age = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export default function Interventions({ onError }) {
  const { value: all } = usePolled(api.interventions, 1500);
  if (!all) return <p className="muted">Loading…</p>;

  const waiting = all.filter((i) => i.status === "open" || i.status === "claimed");
  const past = all.filter((i) => i.status === "resolved" || i.status === "expired").slice(-10).reverse();

  const claim = async (i) => {
    try {
      await api.claim(i.id, "operator-1");
      go(`/runs/${i.runId}`);
    } catch (e) {
      // 409 is the expected answer when somebody else got there first.
      onError(e.status === 409 ? `Another operator has control: ${e.message}` : e.message);
    }
  };

  return (
    <>
      <h2>Waiting for a person</h2>
      {!waiting.length && <p className="muted">Nothing is waiting.</p>}
      <ul className="inbox">
        {waiting.map((i) => (
          <li key={i.id} className={`inbox__item inbox__item--${i.status}`}>
            <div>
              <strong>{i.kind.replace("_", " ")}</strong> <span className="muted">{i.reason}</span>
              <p>{i.detail}</p>
              <p className="muted">
                {i.capabilityId ?? i.goal} · {i.stepId ?? "run level"} · open {age(i.createdAt)}
                {i.claimedBy && ` · claimed by ${i.claimedBy}`}
              </p>
            </div>
            <div className="inbox__actions">
              {i.status === "open" ? (
                <button className="primary" onClick={() => claim(i)}>
                  Take control
                </button>
              ) : (
                <Link to={`/runs/${i.runId}`}>Open</Link>
              )}
            </div>
          </li>
        ))}
      </ul>

      {past.length > 0 && (
        <>
          <h3>Recently closed</h3>
          <ul className="inbox inbox--past">
            {past.map((i) => (
              <li key={i.id}>
                <span className={`pill pill--${i.status}`}>{i.status}</span> {i.kind.replace("_", " ")}{" "}
                <span className="muted">
                  {i.resolution ? `${i.resolution.resumeAt} by ${i.resolution.by}${i.resolution.note ? ` — "${i.resolution.note}"` : ""}` : "no operator answered"}
                </span>{" "}
                <Link to={`/runs/${i.runId}`}>run</Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

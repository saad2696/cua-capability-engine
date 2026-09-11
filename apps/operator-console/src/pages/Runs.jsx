/** Every run this server has seen, newest first. */
import { usePolled } from "../hooks.js";
import { api } from "../api.js";
import { Link } from "../router.jsx";

const when = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "—");

export default function Runs() {
  const { value: runs } = usePolled(api.runs, 2000);
  if (!runs) return <p className="muted">Loading…</p>;
  if (!runs.length)
    return (
      <p className="muted">
        No runs yet. <Link to="/">Start one.</Link>
      </p>
    );

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Run</th>
          <th>Kind</th>
          <th>Capability</th>
          <th>Status</th>
          <th>Controller</th>
          <th>Started</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>
              <Link to={`/runs/${r.id}`}>{r.id}</Link>
            </td>
            <td>{r.kind}</td>
            <td>
              {r.capabilityId}
              {r.kind === "replay" && <span className="muted">@{r.capabilityVersion}</span>}
            </td>
            <td>
              <span className={`pill pill--${r.status}`}>{r.status.replace("_", " ")}</span>
            </td>
            <td>{r.session?.controller ?? "—"}</td>
            <td>{when(r.startedAt)}</td>
            <td>
              {r.result ? (
                <span className={`pill pill--${r.result.status}`}>
                  {r.result.status.replace("_", " ")}
                  {r.result.code ? ` ${r.result.code}` : ""}
                </span>
              ) : r.discovery ? (
                <span className="muted">{r.discovery.status}</span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

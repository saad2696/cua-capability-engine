/**
 * The console shell: navigation, the engine-connection check, and a place for errors to land.
 *
 * The console deliberately owns no engine logic. It cannot take control, resolve an intervention or
 * decide what a run does next — every one of those is a request to the server, which owns the state
 * machine. That is why the headless demo script and this UI can drive the same run without either
 * of them being the authority.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import Artifacts from "./pages/Artifacts.jsx";
import EntryGate from "./pages/EntryGate.jsx";
import Interventions from "./pages/Interventions.jsx";
import LiveSession from "./pages/LiveSession.jsx";
import Runs from "./pages/Runs.jsx";
import { Link, useRoute } from "./router.jsx";
import { usePolled } from "./hooks.js";

const NAV = [
  { to: "/", label: "Start" },
  { to: "/runs", label: "Runs" },
  { to: "/interventions", label: "Waiting" },
  { to: "/artifacts", label: "Capabilities" },
];

export default function App() {
  const { path, segments } = useRoute();
  const [demo, setDemo] = useState();
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const onError = useCallback((message) => setError(message), []);

  useEffect(() => {
    api.demo().then(
      (d) => {
        setDemo(d);
        setOffline(false);
      },
      () => setOffline(true),
    );
  }, []);

  // The count of what is waiting belongs in the navigation: an operator should not have to open a
  // page to find out that a run has stopped for them.
  const { value: waiting } = usePolled(api.interventions, 2000);
  const openCount = (waiting ?? []).filter((i) => i.status === "open").length;

  const runId = segments[0] === "runs" && segments[1] ? segments[1] : undefined;

  return (
    <div className="app">
      <header className="app__head">
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true" />
          <div>
            <strong>Capability engine</strong>
            <span className="muted">operator console</span>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className={path === n.to ? "nav nav--on" : "nav"}>
              {n.label}
              {n.to === "/interventions" && openCount > 0 && <span className="count">{openCount}</span>}
            </Link>
          ))}
        </nav>
      </header>

      {offline && (
        <div className="banner banner--bad">
          No engine on this port. Start it with <code>pnpm serve</code>, and the mock application with{" "}
          <code>pnpm dev:target</code>.
        </div>
      )}
      {error && (
        <div className="banner banner--warn">
          {error}
          <button className="link" onClick={() => setError("")}>
            dismiss
          </button>
        </div>
      )}

      <main className="app__body">
        {runId ? (
          <LiveSession runId={runId} demo={demo} onError={onError} />
        ) : path === "/runs" ? (
          <Runs />
        ) : path === "/interventions" ? (
          <Interventions onError={onError} />
        ) : path === "/artifacts" ? (
          <Artifacts onError={onError} />
        ) : (
          <EntryGate demo={demo} onError={onError} />
        )}
      </main>
    </div>
  );
}

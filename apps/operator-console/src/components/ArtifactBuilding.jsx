/**
 * Discovery, watched as it turns into an artifact.
 *
 * This is the part of the system that is hardest to believe from a log: the model works the flow out
 * once, and what gets kept is a typed, parameterised recipe rather than a transcript. So the panel
 * fills in as the run proceeds, and shows the two substitutions that matter — a typed member id
 * becoming a parameter reference, and a typed password becoming a secret reference. Neither value
 * is ever in the artifact, and you can watch that happen.
 */
import { useMemo } from "react";

function build(events) {
  const steps = [];
  let outputs = [];
  for (const e of events) {
    if (e.type === "act" && e.ok && e.action !== "assert") {
      steps.push({ action: e.action, target: e.target, value: e.value, controller: e.controller });
    }
    if (e.type === "extract") outputs = [...outputs.filter((o) => o.name !== e.output), { name: e.output, parsed: e.parsed, strategy: e.strategy }];
  }
  return { steps, outputs };
}

export default function ArtifactBuilding({ events, run }) {
  const { steps, outputs } = useMemo(() => build(events), [events]);
  const pruned = events.find((e) => e.type === "pruned");

  return (
    <section className="building">
      <header>
        <h3>Artifact taking shape</h3>
        <p className="muted">
          Recorded as the model works. Values it typed become references, so the recipe is reusable and the values stay out of it.
        </p>
      </header>

      <ol className="building__steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="building__n">{i + 1}</span>
            <span>
              {s.action} {s.target && <code>{s.target}</code>}{" "}
              {s.value && (
                // A value shown as {name} is a reference the engine will substitute at replay time;
                // a redaction marker means the recorder saw a secret and kept only its name.
                <span className={/^\{.+\}$/.test(s.value) || s.value.includes("[redacted") ? "ref" : "literal"}>{s.value}</span>
              )}
            </span>
          </li>
        ))}
        {!steps.length && <li className="muted">Nothing recorded yet.</li>}
      </ol>

      {outputs.length > 0 && (
        <div className="building__outputs">
          <h4>Outputs</h4>
          <ul>
            {outputs.map((o) => (
              <li key={o.name}>
                <code>{o.name}</code> = {JSON.stringify(o.parsed)} <span className="muted">via {o.strategy}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pruned && (
        <p className="muted">
          Pruned {pruned.removedStepIds?.length ?? 0} step(s) the model tried and backed out of — the artifact keeps the route
          that worked, not the exploration.
        </p>
      )}

      {run?.discovery && (
        <p className="muted">
          discovery {run.discovery.status} after {run.discovery.stepsTaken} model steps
        </p>
      )}
    </section>
  );
}

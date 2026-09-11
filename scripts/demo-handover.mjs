#!/usr/bin/env node
/**
 * The escalation story, end to end, with no UI involved.
 *
 * Starts a replay whose search step is marked risky, waits for the engine to park the run, takes
 * control over the websocket the way the console will, looks at a live frame of the automation's
 * own browser, optionally perturbs the running app, then hands control back and watches the same
 * session finish. Proof that slice 008's console is a client of a real API.
 *
 *   node scripts/demo-handover.mjs [--server http://127.0.0.1:4200] [--member 10042] [--fault session_expired]
 */
// Node's own WebSocket, so this script needs no dependencies and can be pasted anywhere.
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const server = arg("server", "http://127.0.0.1:4200");
const member = arg("member", "10042");
const fault = arg("fault", undefined);

const api = async (path, method = "GET", body) => {
  const res = await fetch(`${server}${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const say = (s) => console.log(s);
const until = async (fn, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
};

const health = await api("/api/health");
if (health.status !== 200) {
  console.error(`no server at ${server}. Start one with:  pnpm cua serve`);
  process.exit(1);
}

// A capability whose search step needs a human. Sent inline so the demo never edits a file on disk.
const artifact = (await api("/api/artifacts/member-savings-balance@2.json")).body;
artifact.steps[1].risk = "risky";

say(`1. starting a replay of ${artifact.capability.id}@${artifact.capability.version} for member ${member}`);
const started = (await api("/api/replay", "POST", { artifact, params: { memberId: member } })).body;
say(`   run ${started.id}`);

const intervention = await until(async () => {
  const r = (await api(`/api/runs/${started.id}`)).body;
  return r.session.interventions.find((i) => i.status === "open");
});
say(`2. the engine stopped and asked for a person: ${intervention.kind} at ${intervention.stepId}`);
say(`   "${intervention.detail}"`);
say(`   run state is now ${(await api(`/api/runs/${started.id}`)).body.session.state} — nobody is driving`);

if (fault) {
  say(`3. arming "${fault}" inside the live browser while the run is parked`);
  const armed = await api(`/api/runs/${started.id}/scenario`, "POST", { fault });
  say(`   ${armed.status === 200 ? "armed" : `failed: ${armed.body?.error}`}`);
}

say(`${fault ? 4 : 3}. taking control over the websocket`);
const ws = new WebSocket(`${server.replace("http", "ws")}/ws/runs/${started.id}/live`);
const seen = [];
ws.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

ws.send(JSON.stringify({ type: "mouse", op: "click", x: 5, y: 5 }));
const refused = await until(async () => seen.find((m) => m.type === "error"));
say(`   input before claiming is refused: "${refused.error}"`);

ws.send(JSON.stringify({ type: "claim", interventionId: intervention.id, by: "operator-1" }));
await until(async () => seen.find((m) => m.type === "claimed"));
say(`   claimed; run state is ${(await api(`/api/runs/${started.id}`)).body.session.state}`);

const frame = await until(async () => seen.find((m) => m.type === "frame"));
say(`   receiving live frames of the automation's own browser: ${Math.round(frame.png.length / 1024)}KB at ${frame.url}`);

say(`${fault ? 5 : 4}. handing control back with resumeAt=same`);
ws.send(JSON.stringify({ type: "resolve", interventionId: intervention.id, resumeAt: "same", by: "operator-1", note: "approved by hand" }));
await until(async () => seen.find((m) => m.type === "resolved"));
ws.close();

// A recovery restarts the flow, and a risky step that runs twice is approved twice.
let approvals = 1;
const done = await until(async () => {
  const r = (await api(`/api/runs/${started.id}`)).body;
  if (r.status === "completed" || r.status === "failed") return r;
  const open = r.session.interventions.find((i) => i.status === "open");
  if (open) {
    await api(`/api/interventions/${open.id}/claim`, "POST", { by: "operator-1" });
    await api(`/api/interventions/${open.id}/resolve`, "POST", { resumeAt: "same", by: "operator-1" });
    approvals += 1;
    say(`   approved again after a restart (${approvals} total)`);
  }
  return undefined;
}, 120_000);

say(`${fault ? 6 : 5}. the same session finished: ${done.result.status}`);
if (done.result.outputs) say(`   outputs ${JSON.stringify(done.result.outputs)}`);
if (done.result.recoveries?.length) say(`   recoveries ${done.result.recoveries.map((r) => `${r.code} via ${r.recovery}`).join(", ")}`);
say(`   ${done.result.stepsRun} steps, side effects ${done.result.sideEffects}, handoffs ${done.session.handoffs.length}`);
say(`   evidence ${done.evidenceDir}`);
process.exit(done.status === "completed" ? 0 : 2);

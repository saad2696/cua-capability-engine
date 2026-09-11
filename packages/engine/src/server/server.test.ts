/**
 * The control plane, end to end, against a real browser and the real mock app.
 *
 * The claim under test is the one the brief actually makes: a human takes control of the *same live
 * session*, not a copy. So these tests assert on continuity — the run resumes inside the step it
 * stopped at, the browser is never restarted, and the value the flow finally extracts is the one a
 * human's own clicks made reachable.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../../../apps/target-app/src/server.js";
import { FakeProvider, type ScriptStep } from "../llm/FakeProvider.js";
import { startServer, type RunningServer } from "./server.js";

let target: Server;
let base: string;
let api: RunningServer;
let evidenceRoot: string;
const artifactPath = new URL("../../../../artifacts/member-savings-balance@2.json", import.meta.url).pathname;

beforeAll(async () => {
  const { app } = createApp({ credentials: { user: "demo", password: "demo" } });
  target = app.listen(0);
  await new Promise<void>((r) => target.once("listening", r));
  base = `http://localhost:${(target.address() as { port: number }).port}`;
  evidenceRoot = mkdtempSync(join(tmpdir(), "cua-server-"));
  api = await startServer(0, {
    evidenceDir: evidenceRoot, secrets: { TARGET_USER: "demo", TARGET_PASSWORD: "demo" }, interventionTimeoutMs: 120_000,
    // The scripted provider, so the discovery path is exercised with no API key and no cost.
    provider: () => new FakeProvider(DISCOVERY_SCRIPT),
  });
}, 60_000);

afterAll(async () => {
  await api.close();
  await new Promise<void>((r) => target.close(() => r()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

/** Enough of goal G1 to reach a risky action, so discovery has something to escalate about. */
const DISCOVERY_SCRIPT: ScriptStep[] = [
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "User Name"), text: "{TARGET_USER}" }, reasoning: "user name" }),
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Password"), text: "{TARGET_PASSWORD}" }, reasoning: "password" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Sign In") }, reasoning: "sign in" }),
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Member ID"), text: "{memberId}" }, reasoning: "member id" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Search") }, reasoning: "search" }),
  () => ({ tool: "extract", args: { output: "savingsBalance", value: "$1,234.56", description: "Current savings balance", rowLabel: "Savings", columnHeader: "Current Balance" }, reasoning: "read the balance" }),
  () => ({ tool: "done", args: { summary: "Read the savings balance" }, reasoning: "done" }),
];

const url = (p: string) => `http://127.0.0.1:${api.port}${p}`;
const post = (p: string, body?: unknown) => fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = (p: string) => fetch(url(p));

/** The recorded artifact, re-pointed at this test's target-app port. */
async function artifact(mutate?: (c: Record<string, unknown>) => void) {
  const c = JSON.parse(readFileSync(artifactPath, "utf8").split("http://localhost:4100").join(base)) as Record<string, unknown>;
  mutate?.(c);
  return c;
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const runOf = async (id: string) => (await get(`/api/runs/${id}`)).json() as Promise<{ status: string; finishedAt?: string; session: { state: string; interventions: { id: string; status: string; detail: string; kind: string }[] }; result?: { status: string; outputs?: Record<string, unknown>; stepsRun: number; recoveries: { code: string }[] } }>;

describe("the API alone is enough to drive a run", () => {
  it("lists artifacts and rejects a malformed one before starting anything", async () => {
    const list = (await get("/api/artifacts")).json() as unknown as Promise<{ id: string }[]>;
    expect((await list).some((a) => a.id === "member-savings-balance")).toBe(true);

    const bad = await post("/api/replay", { artifact: { capability: { id: "nope" } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid artifact");
  });

  it("runs a replay to success and streams its events", async () => {
    const started = await (await post("/api/replay", { artifact: await artifact(), params: { memberId: "10042" } })).json() as { id: string };
    const done = await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    expect(done.status).toBe("completed");
    expect(done.result?.outputs?.["savingsBalance"]).toEqual({ amount: 1234.56, currency: "USD" });

    // The event stream replays what a late subscriber missed, which is what lets a console attach
    // to a run already in flight.
    const res = await fetch(url(`/api/runs/${started.id}/events`));
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(chunk).toContain("run_started");
  }, 90_000);
});

describe("a human takes control of the same live session", () => {
  it("pauses a healthy run, acts in the operator's own browser, and hands back", async () => {
    // A run that will stop on its own: the search button is marked risky, and risky steps need a
    // person, so the engine parks the run right before the click.
    const art = await artifact((c) => {
      const steps = c["steps"] as { risk: string }[];
      steps[1]!.risk = "risky";
    });
    const started = await (await post("/api/replay", { artifact: art, params: { memberId: "10042" } })).json() as { id: string };

    const iv = await until(async () => {
      const r = await runOf(started.id);
      return r.session.interventions.find((i) => i.status === "open");
    });
    expect(iv.kind).toBe("risky_step");
    const paused = await runOf(started.id);
    expect(paused.session.state).toBe("paused");
    expect(paused.status).toBe("paused");

    // Take control over the websocket, the way the console will.
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws/runs/${started.id}/live`);
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise<void>((r) => ws.once("open", () => r()));

    // Input before claiming is refused: the lease is the authority, not the socket.
    ws.send(JSON.stringify({ type: "mouse", op: "click", x: 10, y: 10 }));
    await until(async () => messages.find((m) => m["type"] === "error" && String(m["error"]).includes("claim")));

    ws.send(JSON.stringify({ type: "claim", interventionId: iv.id, by: "tester" }));
    await until(async () => messages.find((m) => m["type"] === "claimed"));
    expect((await runOf(started.id)).session.state).toBe("human_control");

    // Frames only flow while the run is stopped and somebody is looking.
    const frame = await until(async () => messages.find((m) => m["type"] === "frame")) as { png: string; url: string };
    expect(frame.png.length).toBeGreaterThan(100);

    ws.send(JSON.stringify({ type: "resolve", interventionId: iv.id, resumeAt: "same", by: "tester", note: "approved by hand" }));
    await until(async () => messages.find((m) => m["type"] === "resolved"));
    ws.close();

    const done = await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    // The run finished in the session it paused in: same browser, same cookies, same logged-in
    // operator. A restart would have had to sign in again and would show more steps than this.
    expect(done.status).toBe("completed");
    expect(done.result?.outputs?.["savingsBalance"]).toEqual({ amount: 1234.56, currency: "USD" });
    expect(done.result?.stepsRun).toBe(7);
  }, 120_000);

  it("an operator who claimed over HTTP still loses control when their socket drops", async () => {
    // The two halves of taking control can arrive over different transports: claim with a POST, then
    // open the socket for frames. The disconnect handler must key off the session's state, not off
    // whether that particular socket did the claiming.
    const art = await artifact((c) => { (c["steps"] as { risk: string }[])[1]!.risk = "risky"; });
    const started = await (await post("/api/replay", { artifact: art, params: { memberId: "10042" } })).json() as { id: string };
    const iv = await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open"));

    await post(`/api/interventions/${iv.id}/claim`, { by: "tester" });
    expect((await runOf(started.id)).session.state).toBe("human_control");

    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws/runs/${started.id}/live`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.close();

    // The grace period is 60s by default, so the run must still be theirs a moment later.
    await new Promise((r) => setTimeout(r, 200));
    const after = await runOf(started.id);
    expect(after.session.state).toBe("human_control");
    expect(after.session.interventions.find((i) => i.id === iv.id)?.status).toBe("claimed");

    await post(`/api/interventions/${iv.id}/resolve`, { resumeAt: "abort", by: "tester" });
    await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
  }, 120_000);

  it("a manual pause stops a healthy run between steps and resumes it", async () => {
    const started = await (await post("/api/replay", { artifact: await artifact(), params: { memberId: "10077" } })).json() as { id: string };
    const pause = await post(`/api/runs/${started.id}/pause`, { by: "tester" });
    // The run may already have finished; a pause on a finished run is a no-op, not a failure.
    if (pause.status === 201) {
      const iv = await pause.json() as { id: string; kind: string };
      expect(iv.kind).toBe("manual_pause");
      // A pause takes effect at the next between-steps check, so the state follows shortly after the
      // request rather than with it — and a run this short may simply finish first.
      await until(async () => {
        const r = await runOf(started.id);
        return r.session.state === "paused" || r.finishedAt ? r : undefined;
      }, 20_000);
      const resolved = await post(`/api/interventions/${iv.id}/resolve`, { resumeAt: "same", by: "tester" });
      expect(resolved.status).toBe(200);
    }
    const done = await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    expect(done.status).toBe("completed");
    expect(done.result?.outputs?.["savingsBalance"]).toEqual({ amount: 8900.04, currency: "USD" });
  }, 120_000);

  it("a second operator claiming an intervention gets a conflict, not a second lease", async () => {
    const art = await artifact((c) => { (c["steps"] as { risk: string }[])[1]!.risk = "risky"; });
    const started = await (await post("/api/replay", { artifact: art, params: { memberId: "10042" } })).json() as { id: string };
    const iv = await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open"));

    expect((await post(`/api/interventions/${iv.id}/claim`, { by: "first" })).status).toBe(200);
    const second = await post(`/api/interventions/${iv.id}/claim`, { by: "second" });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("first");

    await post(`/api/interventions/${iv.id}/resolve`, { resumeAt: "abort", by: "first" });
    await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
  }, 120_000);
});

describe("scenario injection perturbs a run that is already in flight", () => {
  it("arms a fault inside the live browser and the flow recovers from it", async () => {
    const art = await artifact((c) => { (c["steps"] as { risk: string }[])[1]!.risk = "risky"; });
    const started = await (await post("/api/replay", { artifact: art, params: { memberId: "10042" } })).json() as { id: string };
    // Wait for the run to park itself, so the fault is armed into a session that is genuinely live.
    await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open"));

    // While the run is parked, make the next authenticated request expire the session.
    const armed = await post(`/api/runs/${started.id}/scenario`, { fault: "session_expired" });
    expect(armed.status).toBe(200);
    expect(await armed.json()).toMatchObject({ ok: true, fault: "session_expired" });

    // Answer every approval the run asks for, including the second one: recovering from the expiry
    // restarts the main flow, and a risky step that runs twice must be approved twice. That is the
    // behaviour worth showing, not a corner to route around.
    let approvals = 0;
    const done = await until(async () => {
      const r = await runOf(started.id);
      if (r.status === "completed" || r.status === "failed") return r;
      const open = r.session.interventions.find((i) => i.status === "open");
      if (open) {
        await post(`/api/interventions/${open.id}/claim`, { by: "tester" });
        await post(`/api/interventions/${open.id}/resolve`, { resumeAt: "same", by: "tester" });
        approvals += 1;
      }
      return undefined;
    });
    // The injected fault was real: the engine had to notice it and re-authenticate.
    expect(done.status).toBe("completed");
    expect(approvals).toBeGreaterThan(1);
    expect(done.result?.recoveries.map((r) => r.code)).toContain("SESSION_EXPIRED");
    expect(done.result?.stepsRun).toBeGreaterThan(7);
  }, 150_000);

  it("refuses to arm a scenario on a run that has finished", async () => {
    const started = await (await post("/api/replay", { artifact: await artifact(), params: { memberId: "10042" } })).json() as { id: string };
    await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    const res = await post(`/api/runs/${started.id}/scenario`, { fault: "slow" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already finished");
  }, 120_000);
});

describe("discovery runs under the same session control", () => {
  it("starts a discovery run from the API and drives it to completion", async () => {
    const started = await (await post("/api/discover", { goal: "Look up member {memberId} and read the current savings balance", url: `${base}/`, capabilityId: "member-savings-balance", params: { memberId: "10042" } })).json() as { id: string; kind: string };
    expect(started.kind).toBe("discover");
    const done = await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    expect(done.status).toBe("completed");
    // The model's decisions are in the log; this is the one path where they should be.
    const reader = (await get(`/api/runs/${started.id}/events`)).body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(chunk.value)).toContain("run_started");
  }, 120_000);

  it("reports a missing model provider as a bad request, not a crash", async () => {
    const api2 = await startServer(0, { evidenceDir: evidenceRoot, provider: () => { throw new Error("ANTHROPIC_API_KEY is not set"); } });
    try {
      const res = await fetch(`http://127.0.0.1:${api2.port}/api/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: "g", url: base }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("ANTHROPIC_API_KEY");
    } finally {
      await api2.close();
    }
  }, 30_000);
});

describe("nothing a run touches leaks the values it was given", () => {
  it("no parameter or secret appears in any file a handover writes", async () => {
    const { readdirSync, readFileSync: read, statSync } = await import("node:fs");

    const art = await artifact((c) => { (c["steps"] as { risk: string }[])[1]!.risk = "risky"; });
    const started = await (await post("/api/replay", { artifact: art, params: { memberId: "10042" } })).json() as { id: string; evidenceDir: string };
    const iv = await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open"));
    await post(`/api/interventions/${iv.id}/claim`, { by: "tester" });
    await post(`/api/interventions/${iv.id}/resolve`, { resumeAt: "same", by: "tester" });
    await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });

    // interventions.json is the one that got this wrong: it records the screen an operator saw, and
    // on this application the member id is in the URL.
    const files = readdirSync(started.evidenceDir).filter((f) => statSync(join(started.evidenceDir, f)).isFile() && !f.endsWith(".zip"));
    expect(files).toContain("interventions.json");
    for (const f of files) {
      const text = read(join(started.evidenceDir, f), "utf8");
      expect(text, `${f} leaked the member id`).not.toContain("10042");
      expect(text, `${f} leaked the password`).not.toContain("demo");
    }
  }, 120_000);
});

describe("an error the engine cannot handle becomes a handover", () => {
  it("escalates an undeclared dialog, lets a person clear it, and finishes the run", async () => {
    // The demonstration the console's "break something" panel exists for. An undeclared dialog is
    // the one fault in the list the engine is not supposed to recover from: it stops, says exactly
    // what it saw, and asks for a person. A one-shot fault, so clearing it is enough to continue.
    const started = await (await post("/api/replay", { artifact: await artifact(), params: { memberId: "10042" }, pauseAtStart: true })).json() as { id: string };
    const first = await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open"));
    await post(`/api/runs/${started.id}/scenario`, { fault: "blocking_dialog" });
    await post(`/api/interventions/${first.id}/resolve`, { resumeAt: "same", by: "tester" });

    const escalation = await until(async () => (await runOf(started.id)).session.interventions.find((i) => i.status === "open" && i.kind === "replay_failure"));
    expect(escalation.reason).toBe("OUTCOME_ESCALATE");
    expect(escalation.detail).toContain("UNKNOWN_DIALOG");
    expect(escalation.detail).toContain("ERR-7731");

    // Nothing dismisses the dialog on the engine's behalf. It is still open, and it is the operator
    // who answers it — over the same websocket the console uses.
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}/ws/runs/${started.id}/live`);
    const seen: Record<string, unknown>[] = [];
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as Record<string, unknown>));
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "claim", interventionId: escalation.id, by: "tester" }));
    await until(async () => seen.find((m) => m["type"] === "claimed"));

    const frame = await until(async () => seen.find((m) => m["type"] === "frame" && m["dialog"])) as { dialog: { message: string } };
    expect(frame.dialog.message).toContain("ERR-7731");

    ws.send(JSON.stringify({ type: "dialog", accept: true }));
    await until(async () => seen.find((m) => m["type"] === "ack"));
    ws.send(JSON.stringify({ type: "resolve", interventionId: escalation.id, resumeAt: "same", by: "tester" }));
    await until(async () => seen.find((m) => m["type"] === "resolved"));
    ws.close();

    const done = await until(async () => {
      const r = await runOf(started.id);
      return r.status === "completed" || r.status === "failed" ? r : undefined;
    });
    expect(done.status).toBe("completed");
    expect(done.result?.outputs?.["savingsBalance"]).toEqual({ amount: 1234.56, currency: "USD" });

    // What the operator did is on the record, in the same vocabulary as the engine's own actions.
    const events = readFileSync(join(evidenceRoot, started.id, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"human_action"');
    expect(events).toContain("dialog accept");
    // One hand-back per decision: the pause, then this escalation. The engine used to log a second,
    // identical resume for the same answer.
    expect(events.split('"resumeAt":"same"').length - 1).toBe(2);
  }, 150_000);
});

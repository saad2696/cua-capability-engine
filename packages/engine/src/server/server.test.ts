/**
 * The control plane, end to end, against a real browser and the real mock app.
 *
 * The claim under test is the one the brief actually makes: a human takes control of the *same live
 * session*, not a copy. So these tests assert on continuity — the run resumes inside the step it
 * stopped at, the browser is never restarted, and the value the flow finally extracts is the one a
 * human's own clicks made reachable.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../../../../apps/target-app/src/server.js";
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
  api = await startServer(0, { evidenceDir: evidenceRoot, secrets: { TARGET_USER: "demo", TARGET_PASSWORD: "demo" }, interventionTimeoutMs: 120_000 });
}, 60_000);

afterAll(async () => {
  await api.close();
  await new Promise<void>((r) => target.close(() => r()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

const url = (p: string) => `http://127.0.0.1:${api.port}${p}`;
const post = (p: string, body?: unknown) => fetch(url(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const get = (p: string) => fetch(url(p));

/** The recorded artifact, re-pointed at this test's target-app port. */
async function artifact(mutate?: (c: Record<string, unknown>) => void) {
  const { readFileSync } = await import("node:fs");
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

const runOf = async (id: string) => (await get(`/api/runs/${id}`)).json() as Promise<{ status: string; session: { state: string; interventions: { id: string; status: string; detail: string; kind: string }[] }; result?: { status: string; outputs?: Record<string, unknown>; stepsRun: number; recoveries: { code: string }[] } }>;

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

  it("a manual pause stops a healthy run between steps and resumes it", async () => {
    const started = await (await post("/api/replay", { artifact: await artifact(), params: { memberId: "10077" } })).json() as { id: string };
    const pause = await post(`/api/runs/${started.id}/pause`, { by: "tester" });
    // The run may already have finished; a pause on a finished run is a no-op, not a failure.
    if (pause.status === 201) {
      const iv = await pause.json() as { id: string; kind: string };
      expect(iv.kind).toBe("manual_pause");
      expect((await runOf(started.id)).session.state).toBe("paused");
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

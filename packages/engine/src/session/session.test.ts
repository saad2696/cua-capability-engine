/**
 * Session control: the state machine, the lease, and the two ways a run blocks on a person.
 * No browser here — a fake surface keeps these fast and deterministic. The live-session behaviour
 * (a real handover mid-replay) is covered in server.test.ts against Chromium.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import { Redactor } from "../evidence/redactor.js";
import type { Observation, Surface } from "../surface/types.js";
import { Session } from "./Session.js";
import { ControlViolation } from "./types.js";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "cua-session-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const observation = (): Observation => ({
  at: new Date().toISOString(), url: "http://localhost:4100/search", title: "Search",
  frames: [], landmarks: [], elements: [{ index: 1, role: "button", name: "Search", frame: ["main"], bbox: [10, 10, 40, 14] }],
  screenshotPng: Buffer.alloc(0), rawScreenshotPng: Buffer.alloc(0), viewport: { width: 1280, height: 800 },
});

/** Records what actually reached the browser, so "who acted" is observable rather than asserted. */
function fakeSurface() {
  const acts: string[] = [];
  const surface = {
    kind: "web" as const,
    open: async () => { acts.push("open"); },
    observe: async () => observation(),
    act: async (a: { kind: string }) => { acts.push(a.kind); return { ok: true, durationMs: 1 }; },
    resolve: async () => null, captureLocator: async () => { throw new Error("n/a"); },
    readText: async () => null, readValue: async () => null,
    setCookie: async () => { acts.push("setCookie"); }, reload: async () => { acts.push("reload"); },
    extract: async () => null, visibleText: async () => "", landmarkVisible: async () => true,
    frameUrl: () => "http://localhost:4100/search", pendingDialog: () => undefined,
    screenshot: async () => Buffer.alloc(0), onPageSwitch: () => {}, close: async () => {},
  } as unknown as Surface;
  return { surface, acts };
}

function makeSession(extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const { surface, acts } = fakeSurface();
  const runId = `s-${Math.random().toString(36).slice(2, 8)}`;
  const evidence = new EvidenceWriter(runId, root, new Redactor({ secrets: {} }));
  const session = new Session({ runId, surface, evidence, engineController: "replay", capabilityId: "member-savings-balance", ...extra });
  const events = () => readFileSync(join(evidence.dir, "events.jsonl"), "utf8");
  return { session, acts, evidence, events };
}

describe("controller state machine", () => {
  it("starts idle with nobody in control and moves to running", () => {
    const { session } = makeSession();
    expect(session.state).toBe("idle");
    expect(session.controller).toBe("none");
    session.start();
    expect(session.state).toBe("running");
    expect(session.controller).toBe("replay");
  });

  it("an escalation parks the run with nobody in control until an operator claims it", async () => {
    const { session, events } = makeSession();
    session.start();
    const decision = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 3, detail: "CHECKPOINT_FAILED" });
    await new Promise((r) => setTimeout(r, 10));
    // Paused is not human_control: the run is waiting, but nobody is driving yet.
    expect(session.state).toBe("paused");
    expect(session.controller).toBe("none");
    const iv = session.openInterventions[0]!;
    expect(iv.status).toBe("open");
    expect(iv.detail).toBe("CHECKPOINT_FAILED");
    expect(iv.suggestedActions).toContain("abort");

    session.claim(iv.id, "operator-1");
    expect(session.state).toBe("human_control");
    expect(session.controller).toBe("human");

    session.resolve(iv.id, "same", "operator-1", "cleared the banner");
    expect(await decision).toBe("same");
    expect(session.controller).toBe("replay");
    expect(events()).toContain('"type":"control_change"');
    expect(events()).toContain('"resumeAt":"same"');
  });

  it("records the handover with its duration and action count", async () => {
    const { session } = makeSession();
    session.start();
    const d = session.onEscalate({ interventionId: "x", reason: "OUTCOME_ESCALATE", stepIndex: 1, detail: "d" });
    await new Promise((r) => setTimeout(r, 10));
    const iv = session.openInterventions[0]!;
    session.claim(iv.id, "op");
    session.recordHumanAction({ at: new Date().toISOString(), action: "click" });
    session.resolve(iv.id, "next", "op");
    await d;
    expect(session.handoffs).toEqual([expect.objectContaining({ from: "human", to: "replay", actions: 1, resumeAt: "next" })]);
  });
});

describe("the lease is enforced, not documented", () => {
  it("the engine cannot act while a human holds control, and can again afterwards", async () => {
    const { session, acts, events } = makeSession();
    const engine = session.start();
    await engine.act({ kind: "click", target: { point: { x: 1, y: 1 } } });
    expect(acts).toEqual(["click"]);

    const d = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 0, detail: "d" });
    await new Promise((r) => setTimeout(r, 10));
    const iv = session.openInterventions[0]!;
    const { surface: human } = session.claim(iv.id, "op");

    // The engine still holds the surface it was handed at start(); it just cannot use it.
    await expect(engine.act({ kind: "click", target: { point: { x: 2, y: 2 } } })).rejects.toBeInstanceOf(ControlViolation);
    expect(acts).toEqual(["click"]);
    expect(events()).toContain("CONTROL_VIOLATION");

    await human.act({ kind: "click", target: { point: { x: 3, y: 3 } } });
    expect(acts).toEqual(["click", "click"]);

    session.resolve(iv.id, "same", "op");
    await d;
    // Handing back restores the engine's original lease rather than minting a new one, so the
    // surface it has held since start() is live again.
    await engine.act({ kind: "click", target: { point: { x: 4, y: 4 } } });
    expect(acts).toHaveLength(3);
    // ...and the operator's lease is dead, so a console that kept its socket open cannot act on.
    await expect(human.act({ kind: "click", target: { point: { x: 5, y: 5 } } })).rejects.toBeInstanceOf(ControlViolation);
  });

  it("reading is always allowed: a paused run still renders for whoever is looking", async () => {
    const { session } = makeSession();
    const engine = session.start();
    const d = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 0, detail: "d" });
    await new Promise((r) => setTimeout(r, 10));
    await expect(engine.observe()).resolves.toMatchObject({ url: "http://localhost:4100/search" });
    await expect(engine.visibleText()).resolves.toBe("");
    session.abort();
    await d;
  });
});

describe("manual pause", () => {
  it("blocks the engine between steps and releases it on resume", async () => {
    const { session } = makeSession();
    session.start();
    expect(await session.shouldContinue()).toBe("continue");

    const iv = await session.pause("operator-1");
    // A pause is a request to stop at the next safe point, not an immediate seizure. Until the
    // engine reaches that point it is still driving — taking the lease away mid-step would leave it
    // unable to finish the action it had already started.
    expect(session.state).toBe("running");
    expect(session.controller).toBe("replay");
    expect(iv.kind).toBe("manual_pause");

    let released = false;
    const blocked = session.shouldContinue().then((r) => { released = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false); // the engine is genuinely stopped, not polling
    // Now it has stopped, so control is genuinely free for an operator to claim.
    expect(session.state).toBe("paused");
    expect(session.controller).toBe("none");

    session.resolve(iv.id, "same", "operator-1");
    expect(await blocked).toBe("continue");
    expect(session.state).toBe("running");
    expect(session.controller).toBe("replay");
  });

  it("aborting a pause stops the run", async () => {
    const { session } = makeSession();
    session.start();
    const iv = await session.pause();
    const blocked = session.shouldContinue();
    await new Promise((r) => setTimeout(r, 10));
    session.resolve(iv.id, "abort", "operator-1");
    expect(await blocked).toBe("abort");
    expect(session.state).toBe("aborted");
  });

  it("the engine can still finish the step it was in when the pause arrived", async () => {
    // The case that made this behaviour necessary: a pause raised before the run's very first step
    // used to revoke the lease immediately, so the engine could not even open the page.
    const { session, acts } = makeSession();
    const engine = session.start();
    await session.pause("operator-1");
    await engine.act({ kind: "navigate", url: "http://localhost:4100/" });
    expect(acts).toEqual(["navigate"]);
  });
});

describe("things that go wrong around an intervention", () => {
  it("a second operator cannot claim what a first already holds", async () => {
    const { session } = makeSession();
    session.start();
    const d = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 0, detail: "d" });
    await new Promise((r) => setTimeout(r, 10));
    const iv = session.openInterventions[0]!;
    session.claim(iv.id, "first");
    expect(() => session.claim(iv.id, "second")).toThrow(/already claimed by first/);
    session.abort();
    await d;
  });

  it("an unanswered intervention expires and aborts the run rather than hanging forever", async () => {
    const { session, events } = makeSession({ interventionTimeoutMs: 50 });
    session.start();
    const decision = await session.onEscalate({ interventionId: "x", reason: "AGENT_GAVE_UP", stepIndex: 0, detail: "stuck" });
    expect(decision).toBe("abort");
    expect(session.state).toBe("aborted");
    expect(session.allInterventions[0]!.status).toBe("expired");
    expect(events()).toContain("INTERVENTION_TIMEOUT");
  });

  it("a disconnected operator loses control after the grace period, and the work returns to the queue", async () => {
    const { session } = makeSession({ disconnectGraceMs: 30 });
    session.start();
    const d = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 0, detail: "d" });
    await new Promise((r) => setTimeout(r, 10));
    const iv = session.openInterventions[0]!;
    session.claim(iv.id, "op");

    session.operatorDisconnected();
    await new Promise((r) => setTimeout(r, 15));
    expect(session.state).toBe("human_control"); // a refresh must not cost them their work

    await new Promise((r) => setTimeout(r, 40));
    expect(session.state).toBe("paused");
    expect(session.controller).toBe("none");
    expect(session.openInterventions[0]!.status).toBe("open");
    expect(session.openInterventions[0]!.claimedBy).toBeUndefined();
    session.abort();
    await d;
  });

  it("writes the intervention record to the run's evidence directory", async () => {
    const { session, evidence } = makeSession();
    session.start();
    const d = session.onEscalate({ interventionId: "x", reason: "REPLAY_FAILURE", stepIndex: 2, detail: "for the record" });
    await new Promise((r) => setTimeout(r, 10));
    const onDisk = JSON.parse(readFileSync(join(evidence.dir, "interventions.json"), "utf8")) as { detail: string; status: string }[];
    expect(onDisk[0]).toMatchObject({ detail: "for the record", status: "open" });
    session.abort();
    await d;
  });
});

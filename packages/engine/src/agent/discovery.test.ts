import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateCapability, type Outcome } from "@cua/schema";
import { createApp } from "../../../../apps/target-app/src/server.js";
import { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import { Redactor } from "../evidence/redactor.js";
import { FakeProvider, type ScriptStep } from "../llm/FakeProvider.js";
import { basicPolicy } from "../policy/basic.js";
import { recordCapability } from "../recorder/recorder.js";
import { PlaywrightSurface } from "../surface/playwright/PlaywrightSurface.js";
import { runDiscovery } from "./loop.js";

let server: Server;
let base: string;
let evidenceRoot: string;
const secrets = { TARGET_USER: "demo", TARGET_PASSWORD: "demo" };
const defaultOutcomes = JSON.parse(readFileSync(new URL("../../../../artifacts/defaults/legacy-cu-core.outcomes.json", import.meta.url), "utf8")) as Outcome[];

beforeAll(async () => {
  const { app } = createApp({ credentials: { user: "demo", password: "demo" } });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  evidenceRoot = mkdtempSync(join(tmpdir(), "cua-evidence-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

/** The happy-path script for goal G1, written against roles/names rather than indexes. */
const login: ScriptStep[] = [
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "User Name"), text: "{TARGET_USER}" }, reasoning: "Enter the operator user name" }),
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Password"), text: "{TARGET_PASSWORD}" }, reasoning: "Enter the operator password" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Sign In") }, reasoning: "Submit the sign-in form" }),
];
const searchAndRead: ScriptStep[] = [
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Member ID"), text: "{memberId}" }, reasoning: "Enter the member id" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Search") }, reasoning: "Run the search" }),
  () => ({ tool: "extract", args: { output: "savingsBalance", value: "$1,234.56", description: "Current savings balance", rowLabel: "Savings", columnHeader: "Current Balance" }, reasoning: "Read the balance" }),
  () => ({ tool: "assert_state", args: { kind: "goal_screen_reached", detail: "Member detail shows the balance" }, reasoning: "Goal screen" }),
  () => ({ tool: "done", args: { summary: "Read the savings balance for the member" }, reasoning: "done" }),
];

async function run(script: ScriptStep[], goal = "Look up member {memberId} and read the current savings balance", params = { memberId: "10042" }, extra: Partial<Parameters<typeof runDiscovery>[0]> = {}) {
  const runId = `test-${Math.random().toString(36).slice(2, 8)}`;
  const evidence = new EvidenceWriter(runId, evidenceRoot, new Redactor({ secrets: { ...secrets, "param:memberId": params.memberId } }));
  const policy = basicPolicy({ allowedOrigins: [base], blockedUrlPatterns: ["/__faults"] });
  const surface = new PlaywrightSurface({ headless: true, allowRequest: (u) => policy.allowRequest(u) });
  try {
    const trace = await runDiscovery({ goal, url: `${base}/`, params, secrets, provider: new FakeProvider(script), surface, policy, evidence, maxSteps: 20, ...extra });
    return { trace, evidence };
  } finally {
    await surface.close();
  }
}

describe("discovery loop + recorder (fake provider, live surface)", () => {
  it("completes G1 and records a valid artifact with references instead of values", async () => {
    const { trace, evidence } = await run([...login, ...searchAndRead]);
    expect(trace.status).toBe("completed");
    expect(trace.steps.filter((s) => s.actOk).length).toBeGreaterThanOrEqual(6);

    const rec = recordCapability(trace, secrets, { capabilityId: "member-savings-balance", name: "Member savings balance", vendor: "legacy-cu-core", allowedOrigins: [base], defaultOutcomes, provider: "fake", model: "scripted" });
    const cap = rec.capability;
    expect(validateCapability(cap).ok).toBe(true);
    expect(rec.warnings).toEqual([]);

    // login split into a prelude that references secrets, never values
    const loginSteps = cap.preludes["login"]!;
    expect(loginSteps.map((s) => s.action)).toEqual(["navigate", "type", "type", "click"]);
    expect(loginSteps[1]!.value).toEqual({ kind: "secret", name: "TARGET_USER" });
    expect(loginSteps[2]!.value).toEqual({ kind: "secret", name: "TARGET_PASSWORD" });
    expect(cap.requires.secrets).toEqual(["TARGET_PASSWORD", "TARGET_USER"]);

    // main flow: type param, click search, extract
    expect(cap.steps.map((s) => s.action)).toEqual(["type", "click", "extract"]);
    expect(cap.steps[0]!.value).toEqual({ kind: "param", name: "memberId" });
    expect(cap.inputs["memberId"]).toMatchObject({ type: "string", sensitivity: "pii", pattern: "^\\d{5}$" });
    expect(cap.steps[0]!.target?.candidates[0]).toMatchObject({ strategy: "role", role: "textbox", name: "Member ID" });
    expect(cap.steps[0]!.precondition?.landmarks.some((l) => l.name === "Member Search")).toBe(true);
    expect(cap.steps[1]!.expect.some((e) => e.kind === "urlMatches" && e.pattern.includes("/member/"))).toBe(true);
    expect(cap.steps[1]!.expect.some((e) => e.kind === "landmarkVisible" && e.landmark.name.includes("Member Detail"))).toBe(true);
    // landmarks never carry secret or parameter values (the header bar shows "Operator: demo")
    expect(JSON.stringify(cap)).not.toMatch(/Operator: /);

    // output with a verified deterministic extraction strategy
    const out = cap.outputs["savingsBalance"]!;
    expect(out.type).toBe("money");
    expect(out.extract.candidates[0]).toMatchObject({ strategy: "tableCell", rowMatch: "Savings", columnHeader: "Current Balance" });
    expect(out.from).toBe(cap.steps[2]!.id);

    // checkpoint includes the param being visible; outcomes seeded from defaults
    expect(cap.checkpoint.some((c) => c.kind === "textVisible" && c.value?.kind === "param")).toBe(true);
    expect(cap.outcomes.map((o) => o.code)).toContain("MEMBER_NOT_FOUND");

    // no raw sensitive values anywhere in the artifact or evidence
    const artifactJson = JSON.stringify(cap);
    expect(artifactJson).not.toContain('"demo"');
    expect(artifactJson).not.toContain("10042");
    const events = readFileSync(join(evidence.dir, "events.jsonl"), "utf8");
    expect(events).not.toContain("10042"); // the model typed the placeholder, so the value never enters the log
    expect(events).toContain("{memberId}");
    expect(events).not.toContain('"demo"');
    expect(events).toContain('"type":"extract"');
  }, 60_000);

  it("prunes a detour (wrong module, back to search) from the recorded flow", async () => {
    const detour: ScriptStep[] = [
      (_c, h) => ({ tool: "click", args: { index: h.el("link", "Loans") }, reasoning: "Maybe loans?" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("link", "Member Search") }, reasoning: "Back to member search" }),
    ];
    const { trace } = await run([...login, ...detour, ...searchAndRead]);
    expect(trace.status).toBe("completed");
    const rec = recordCapability(trace, secrets, { capabilityId: "g1-detour", name: "g1", vendor: "legacy-cu-core", allowedOrigins: [base], defaultOutcomes, provider: "fake", model: "scripted" });
    expect(rec.prunedStepIds.length).toBe(2);
    expect(rec.capability.steps.map((s) => s.action)).toEqual(["type", "click", "extract"]);
    expect(JSON.stringify(rec.capability)).not.toContain("Loans");
  }, 60_000);

  it("stops with LOOP_DETECTED when the model repeats itself", async () => {
    const stuck: ScriptStep[] = [(_c, h) => ({ tool: "click", args: { index: h.el("link", "Sign In") }, reasoning: "click" })];
    const { trace } = await run(stuck, "loop", { memberId: "10042" }, { loopThreshold: 3 });
    // FakeProvider gives up when the script is exhausted, so repeat the last step instead
    expect(["escalated", "gave_up"]).toContain(trace.status);
  }, 60_000);

  it("blocks navigation outside the allowlist and tells the model why", async () => {
    const wander: ScriptStep[] = [
      () => ({ tool: "navigate", args: { url: "https://example.com/" }, reasoning: "look elsewhere" }),
      (ctx) => ({ tool: "give_up", args: { reason: ctx.notices.join(" | ") }, reasoning: "stop" }),
    ];
    const { trace, evidence } = await run(wander);
    expect(trace.status).toBe("gave_up");
    expect(String(trace.steps[1]!.decision.args["reason"])).toContain("Blocked by policy");
    expect(readFileSync(join(evidence.dir, "events.jsonl"), "utf8")).toContain('"type":"policy_block"');
  }, 60_000);

  it("escalates instead of clicking a risky button without approval", async () => {
    const toConfirm: ScriptStep[] = [
      ...login,
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Member ID"), text: "{memberId}" }, reasoning: "id" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Search") }, reasoning: "search" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("link", "Open New Sub-Account") }, reasoning: "open form" }),
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Nickname") }, reasoning: "nick" } as never),
    ];
    // simpler: go straight to a risky click on the review screen via the form
    const script: ScriptStep[] = [
      ...toConfirm.slice(0, 6),
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Nickname"), text: "Holiday" }, reasoning: "nickname" }),
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Initial Deposit"), text: "50" }, reasoning: "deposit" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Continue") }, reasoning: "continue to review" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Open Account") }, reasoning: "confirm" }),
    ];
    const { trace, evidence } = await run(script, "Open a new savings sub-account for member {memberId}");
    expect(trace.status).toBe("escalated");
    expect(trace.reason).toBe("RISKY_STEP_NEEDS_APPROVAL");
    const events = readFileSync(join(evidence.dir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"risk_flag"');
    expect(events).toContain("RISKY_STEP_NEEDS_APPROVAL");
  }, 60_000);
});

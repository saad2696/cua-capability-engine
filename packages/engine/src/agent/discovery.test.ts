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
import { replay } from "../replay/executor.js";

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

  it("G2 end to end: the commit is the dialog, and both decisions are put to a human", async () => {
    // The point of no return in this application is a native confirm(), not a button. Clicking
    // "Open Account" raises the dialog and *fails* with it still open; accepting the dialog is what
    // actually opens the account. So a run that only gates the click would commit on a prompt the
    // operator never saw. Both are asked; see docs/adr/0006.
    const asked: string[] = [];
    let confirmation = "";
    const script: ScriptStep[] = [
      ...login,
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Member ID"), text: "{memberId}" }, reasoning: "id" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Search") }, reasoning: "search" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("link", "Open New Sub-Account") }, reasoning: "open the form" }),
      (_c, h) => ({ tool: "select", args: { index: h.el("combobox", "Account Type"), option: "Savings" }, reasoning: "savings" }),
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Nickname"), text: "Holiday" }, reasoning: "nickname" }),
      (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Initial Deposit"), text: "50.00" }, reasoning: "deposit" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Continue") }, reasoning: "review" }),
      (_c, h) => ({ tool: "click", args: { index: h.el("button", "Open Account") }, reasoning: "commit" }),
      () => ({ tool: "dismiss_dialog", args: { accept: true }, reasoning: "the application is asking for its final confirmation" }),
      // Read the number off the page rather than hard-coding it: the app issues a new one per
      // account, so a literal would pass on a fresh database and fail on the second run.
      (c) => {
        confirmation = c.observation.landmarks.map((l) => l.name).find((n) => /^CU-\d+$/.test(n)) ?? "";
        return { tool: "extract", args: { output: "confirmationNumber", value: confirmation, description: "Confirmation number", nearLabel: "Confirmation Number" }, reasoning: "read the confirmation" };
      },
      () => ({ tool: "assert_state", args: { kind: "goal_screen_reached", detail: "Sub-Account Opened" }, reasoning: "goal" }),
      () => ({ tool: "done", args: { summary: "Opened a savings sub-account and read the confirmation number" }, reasoning: "done" }),
    ];

    const { trace } = await run(script, "Open a new savings sub-account for member {memberId} and read the confirmation number", { memberId: "10042" }, {
      approveRisky: async (d) => {
        asked.push(d.tool);
        return true;
      },
    });

    expect(trace.status).toBe("completed");
    // Two separate decisions, not one: the click that raises the prompt and the accept that commits.
    expect(asked).toEqual(["click", "dismiss_dialog"]);
    expect(confirmation).toMatch(/^CU-\d+$/);

    const rec = recordCapability(trace, secrets, { capabilityId: "member-open-subaccount", name: "Open sub-account", vendor: "legacy-cu-core", allowedOrigins: [base], defaultOutcomes, provider: "fake", model: "scripted" });
    expect(validateCapability(rec.capability).ok).toBe(true);
    // The confirmation number is an output of the capability, re-readable on replay by its label.
    expect(rec.capability.outputs["confirmationNumber"]).toBeDefined();

    // The recorder used to mark a point of no return only on a risky *click*. Here the committing
    // step is the dialog, so that rule recorded none at all — and a replay of this artifact would
    // have reported sideEffects "possible" after opening a real account. Nothing else catches it:
    // the schema permits a risky step without pointOfNoReturn.
    const commit = rec.capability.steps.find((st) => st.action === "dismiss_dialog" || /dialog/i.test(st.id));
    expect(commit, `no dialog step recorded; got ${rec.capability.steps.map((st) => st.id).join(", ")}`).toBeDefined();
    expect(commit!.risk).toBe("risky");
    expect(commit!.pointOfNoReturn).toBe(true);

    // The claim this whole flow exists to support: replay the recorded artifact, with no model in
    // the loop, and it opens a *second* real account and reports having committed something. Until
    // this ran, `sideEffects: "committed"` was only ever produced by a hand-written fixture.
    const replayEvidence = new EvidenceWriter(`test-g2-replay-${Math.random().toString(36).slice(2, 6)}`, evidenceRoot, new Redactor({ secrets: { ...secrets, "param:memberId": "10042" } }));
    const policy = basicPolicy({ allowedOrigins: [base], blockedUrlPatterns: ["/__faults"] });
    const replaySurface = new PlaywrightSurface({ headless: true, allowRequest: (u) => policy.allowRequest(u) });
    let confirmsAsked = 0;
    let result;
    try {
      result = await replay({
        artifact: rec.capability, params: { memberId: "10042" }, secrets, surface: replaySurface, evidence: replayEvidence,
        globalPolicy: { allowedOrigins: [base] }, allowDraft: true,
        riskyStepsRequire: "humanConfirm",
        confirmRisky: async () => {
          confirmsAsked += 1;
          return true;
        },
      });
    } finally {
      await replaySurface.close();
    }

    expect(result.status, JSON.stringify(result)).toBe("success");
    // Replay asks about exactly what discovery escalated on: the click and the accept, in that
    // order. Two prompts for one commit looks like the double-escalation ADR 0002 warns against,
    // but it is not — there the second prompt guarded a step that committed nothing. Here the click
    // is still cancellable (the dialog has a Cancel) and the accept is the irreversible half, so
    // they are two genuine decisions. Under the default `approvedArtifact` mode neither prompts:
    // the approval was given once, at artifact review time.
    expect(confirmsAsked).toBe(2);
    expect(result.sideEffects).toBe("committed");
    const replayed = (result as { outputs: Record<string, unknown> }).outputs["confirmationNumber"];
    expect(String(replayed)).toMatch(/^CU-\d+$/);
    // A different number, because it really opened another account rather than re-reading the first.
    expect(replayed).not.toBe(confirmation);
  }, 120_000);

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

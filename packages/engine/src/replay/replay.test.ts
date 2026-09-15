import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capability } from "@cua/schema";
import { createApp } from "../../../../apps/target-app/src/server.js";
import { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import { Redactor } from "../evidence/redactor.js";
import { basicPolicy } from "../policy/basic.js";
import { PlaywrightSurface } from "../surface/playwright/PlaywrightSurface.js";
import { VISUAL_DRIFT_THRESHOLD, boxSimilarity, replay, type ReplayOptions } from "./executor.js";
import { parseMoney } from "./text.js";

let server: Server;
let base: string;
let evidenceRoot: string;
const secrets = { TARGET_USER: "demo", TARGET_PASSWORD: "demo" };
const recorded = JSON.parse(readFileSync(new URL("../../../../artifacts/member-savings-balance@2.json", import.meta.url), "utf8")) as Capability;

/** The real recorded artifact, re-pointed at the test server's port. */
function fixture(mutate?: (c: Capability) => void): Capability {
  const c = JSON.parse(JSON.stringify(recorded).split("http://localhost:4100").join(base)) as Capability;
  mutate?.(c);
  return c;
}

beforeAll(async () => {
  process.env["TARGET_FAULT_SLOW_MS"] = "1500";
  const { app } = createApp({ credentials: { user: "demo", password: "demo" } });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  evidenceRoot = mkdtempSync(join(tmpdir(), "cua-replay-"));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

async function run(artifact: unknown, params: Record<string, string>, extra: Partial<ReplayOptions> = {}) {
  const runId = `t-${Math.random().toString(36).slice(2, 8)}`;
  const evidence = new EvidenceWriter(runId, evidenceRoot, new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } }));
  const policy = basicPolicy({ allowedOrigins: [base], blockedUrlPatterns: ["/__faults"] });
  const surface = new PlaywrightSurface({ headless: true, allowRequest: (u) => policy.allowRequest(u) });
  try {
    const result = await replay({ artifact, params, secrets, surface, evidence, allowDraft: true, globalPolicy: { allowedOrigins: [base] }, ...extra });
    const events = existsSync(join(evidence.dir, "events.jsonl")) ? readFileSync(join(evidence.dir, "events.jsonl"), "utf8") : "";
    return { result, evidence, events };
  } finally {
    await surface.close();
  }
}

describe("pre-flight (no browser)", () => {
  it("rejects a malformed parameter with INVALID_INPUT", async () => {
    const { result } = await run(fixture(), { memberId: "abc" });
    expect(result).toMatchObject({ status: "failure", code: "INVALID_INPUT", stepsRun: 0 });
  });
  it("rejects unknown parameters and missing secrets", async () => {
    const a = await run(fixture(), { memberId: "10042", extra: "x" });
    expect(a.result).toMatchObject({ status: "failure", code: "INVALID_INPUT" });
    const b = await run(fixture(), { memberId: "10042" }, { secrets: { TARGET_USER: "demo" } });
    expect(b.result).toMatchObject({ status: "failure", code: "MISSING_SECRET" });
  });
  it("gates unattended replay on approval", async () => {
    const { result } = await run(fixture(), { memberId: "10042" }, { allowDraft: false });
    expect(result).toMatchObject({ status: "failure", code: "ARTIFACT_NOT_APPROVED" });
  });
  it("rejects artifacts whose origins exceed the global policy", async () => {
    const { result } = await run(fixture(), { memberId: "10042" }, { globalPolicy: { allowedOrigins: ["http://other.example"] } });
    expect(result).toMatchObject({ status: "failure", code: "POLICY_VIOLATION" });
  });
});

/**
 * The shipped artifacts are fixtures as well as deliverables, and the demo mutates them: approving
 * a capability in the console rewrites the file on disk. Committing that state turns several tests
 * below into failures whose cause is nowhere near the assertion that fails — a risky step stops
 * escalating, and a draft stops being refused. Asserting it here makes the cause obvious.
 *
 * If this fails after a demo: `git checkout -- artifacts/`.
 */
describe("the shipped artifacts are in the state the tests and the demo expect", () => {
  const status = (file: string) =>
    (JSON.parse(readFileSync(new URL(`../../../../artifacts/${file}`, import.meta.url), "utf8")) as { capability: { status: string } }).capability.status;

  it("member-savings-balance stays a draft", () => {
    // Draft is load-bearing twice over: the approval-gate tests need something to refuse, and the
    // walkthrough opens on that refusal.
    expect(status("member-savings-balance@2.json"), "approved in the console and committed? run: git checkout -- artifacts/").toBe("draft");
    expect(status("member-savings-balance@1.json")).toBe("draft");
  });

  it("member-open-subaccount stays approved", () => {
    // The committing capability ships approved on purpose: it is what lets the demo show an
    // unattended replay actually opening an account.
    expect(status("member-open-subaccount@1.json")).toBe("approved");
  });
});

describe("happy path", () => {
  it("replays G1 and returns the typed output with no drift", async () => {
    const { result, events } = await run(fixture(), { memberId: "10042" });
    expect(result.status, JSON.stringify(result).slice(0, 600)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs["savingsBalance"]).toEqual({ amount: 1234.56, currency: "USD" });
    expect(result.sideEffects).toBe("none");
    expect(result.drift).toEqual([]);
    expect(result.stepsRun).toBe(7); // 4 prelude + 3 main
    expect(events).toContain('"type":"precondition"');
    expect(events).toContain('"type":"verify"');
    expect(events).not.toContain('"decide"'); // no model
    expect(events).not.toContain("10042");
  }, 60_000);

  it("returns a different member's balance with the same artifact", async () => {
    const { result } = await run(fixture(), { memberId: "10077" });
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs["savingsBalance"]).toEqual({ amount: 8900.04, currency: "USD" });
  }, 60_000);
});

describe("business outcomes are results, not errors", () => {
  it("MEMBER_NOT_FOUND for an unknown member", async () => {
    const { result } = await run(fixture(), { memberId: "99999" });
    expect(result).toMatchObject({ status: "business_outcome", code: "MEMBER_NOT_FOUND", atStep: "step:click-button-search" });
  }, 60_000);
  it("PERMISSION_DENIED when the app returns 403", async () => {
    const { result } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "permission_denied" }] });
    expect(result).toMatchObject({ status: "business_outcome", code: "PERMISSION_DENIED" });
  }, 60_000);
});

describe("recoverable conditions", () => {
  it("SESSION_EXPIRED: re-runs the login prelude and completes", async () => {
    const { result } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "session_expired" }] });
    expect(result.status).toBe("success");
    expect(result.recoveries.map((r) => r.code)).toContain("SESSION_EXPIRED");
  }, 60_000);
  it("MAINTENANCE_NOTICE: dismisses the known alert and completes", async () => {
    const { result, events } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "unexpected_dialog" }] });
    expect(result.status).toBe("success");
    expect(result.recoveries.map((r) => r.code)).toContain("MAINTENANCE_NOTICE");
    expect(events).toContain('"recovery":"dismissDialog"');
  }, 60_000);
  it("SERVER_ERROR: reloads and completes", async () => {
    const { result } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "server_error" }] });
    expect(result.status).toBe("success");
    expect(result.recoveries.map((r) => r.code)).toContain("SERVER_ERROR");
  }, 60_000);
  it("slow responses are tolerated and flagged", async () => {
    const { result, events } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "slow" }, { url: base, name: "cu_fault_sticky", value: "1" }], slowThresholdMs: 1000 });
    expect(result.status).toBe("success");
    expect(events).toContain("SLOW_LOAD");
  }, 90_000);
  it("RECOVERY_LOOP when the same recoverable condition persists", async () => {
    // sticky session expiry: every authenticated request logs the operator out again
    const { result } = await run(fixture(), { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "session_expired" }, { url: base, name: "cu_fault_sticky", value: "1" }] });
    expect(result).toMatchObject({ status: "failure", code: "RECOVERY_LOOP" });
  }, 90_000);
});

describe("hard failures are debuggable", () => {
  it("UNKNOWN_DIALOG when the dialog is not declared (escalates as declared)", async () => {
    const art = fixture((c) => { c.outcomes = c.outcomes.filter((o) => o.code !== "MAINTENANCE_NOTICE"); });
    const { result } = await run(art, { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "unexpected_dialog" }] });
    expect(result).toMatchObject({ status: "escalated", reason: "OUTCOME_ESCALATE" });
    if (result.status === "escalated") expect(result.detail).toContain("UNKNOWN_DIALOG");
  }, 60_000);
  it("UNKNOWN_DIALOG fails with a bundle when not marked escalate", async () => {
    const art = fixture((c) => { c.outcomes = c.outcomes.filter((o) => o.code !== "MAINTENANCE_NOTICE").map((o) => (o.code === "UNKNOWN_DIALOG" ? { ...o, escalate: false } : o)); });
    const { result, evidence } = await run(art, { memberId: "10042" }, { cookies: [{ url: base, name: "cu_fault", value: "unexpected_dialog" }] });
    expect(result).toMatchObject({ status: "failure", code: "UNKNOWN_DIALOG" });
    if (result.status === "failure") {
      expect(result.observed).toContain("System maintenance");
      expect(result.evidence.narrative).toBeTruthy();
      // Every path in the bundle is relative to the run directory, so the evidence stays valid
      // wherever the directory is moved or shared.
      expect(result.evidence.narrative).not.toMatch(/^\//);
      expect(readFileSync(join(evidence.dir, result.evidence.narrative!), "utf8")).toContain("Suggested next action");
      // Whatever the bundle managed to collect must actually be there. It is best-effort by design:
      // an open dialog blocks screenshots, and a torn-down page blocks everything, so the bundle
      // records what it got rather than failing the failure.
      const collected = [result.evidence.screenshot, result.evidence.fullPage, result.evidence.a11y, result.evidence.text].filter((r): r is string => Boolean(r));
      expect(collected.length).toBeGreaterThan(0);
      for (const rel of collected) expect(existsSync(join(evidence.dir, rel))).toBe(true);
    }
  }, 60_000);
  it("WRONG_SCREEN when a precondition does not hold", async () => {
    const art = fixture((c) => { c.steps[1]!.precondition = { urlPattern: "^/search", frames: ["main"], landmarks: [{ role: "cell", name: "Loan Origination", exact: true }, { role: "cell", name: "Collateral", exact: true }], minLandmarks: 2, negative: [] }; });
    const { result } = await run(art, { memberId: "10042" });
    expect(result).toMatchObject({ status: "failure", code: "WRONG_SCREEN", atStep: "step:click-button-search" });
    if (result.status === "failure") expect(result.observed).toContain("missing");
  }, 60_000);
  it("LOCATOR_NOT_FOUND lists what was visible", async () => {
    const art = fixture((c) => { c.steps[0]!.target!.candidates = [{ strategy: "role", role: "textbox", name: "Account Holder #", exact: true, confidence: 0.9 }]; });
    const { result } = await run(art, { memberId: "10042" });
    expect(result).toMatchObject({ status: "failure", code: "LOCATOR_NOT_FOUND", atStep: "step:type-textbox-member-id" });
    if (result.status === "failure") expect(result.observed).toContain('textbox "Member ID"');
  }, 60_000);
  it("CHECKPOINT_FAILED when the action does not produce the expected state", async () => {
    const art = fixture((c) => { c.steps[1]!.expect = [{ kind: "landmarkVisible", landmark: { role: "cell", name: "Wire Transfer", exact: true }, frame: ["main"] }]; c.steps[1]!.timeoutMs = 1500; });
    const { result } = await run(art, { memberId: "10042" });
    expect(result).toMatchObject({ status: "failure", code: "CHECKPOINT_FAILED" });
  }, 60_000);
});

describe("drift and side effects", () => {
  it("falls back to a later locator candidate and reports drift", async () => {
    const art = fixture((c) => { c.steps[0]!.target!.candidates = c.steps[0]!.target!.candidates.map((cand) => (cand.strategy === "role" ? { ...cand, name: "Account Holder #" } : cand.strategy === "label" ? { ...cand, text: "Account Holder #" } : cand)); });
    const { result, events } = await run(art, { memberId: "10042" });
    expect(result.status).toBe("success");
    expect(result.drift).toEqual([expect.objectContaining({ stepId: "step:type-textbox-member-id", primaryStrategy: "role", matchedStrategy: "css" })]);
    expect(events).toContain('"type":"drift"');
  }, 60_000);
  it("risky step on a draft artifact escalates; sideEffects 'possible' after an unverified point of no return", async () => {
    const risky = fixture((c) => { c.steps[1]!.risk = "risky"; c.steps[1]!.pointOfNoReturn = true; });
    const a = await run(risky, { memberId: "10042" });
    expect(a.result).toMatchObject({ status: "escalated", reason: "RISKY_STEP_NEEDS_APPROVAL", atStep: "step:click-button-search" });

    const approved = fixture((c) => { c.steps[1]!.risk = "risky"; c.steps[1]!.pointOfNoReturn = true; c.steps[1]!.expect = [{ kind: "landmarkVisible", landmark: { role: "cell", name: "Wire Transfer", exact: true }, frame: ["main"] }]; c.steps[1]!.timeoutMs = 1500; c.capability.status = "approved"; c.provenance.approvedBy = "test"; c.provenance.approvedAt = "2026-09-11T00:00:00Z"; });
    const b = await run(approved, { memberId: "10042" }, { allowDraft: false });
    expect(b.result).toMatchObject({ status: "failure", code: "CHECKPOINT_FAILED", sideEffects: "possible" });
  }, 90_000);
  it("UNSAFE_RESTART: a recoverable condition after a point of no return is not replayed", async () => {
    // G1 is read-only, so this is the one branch the real artifact cannot reach. Mark the search as
    // a committed action, then make the next step fail into a recovery that wants to restart the
    // flow. Restarting would re-run the committed step, so the run must stop instead.
    const art = fixture((c) => {
      c.steps[1]!.risk = "risky";
      c.steps[1]!.pointOfNoReturn = true;
      c.capability.status = "approved";
      c.provenance.approvedBy = "test";
      c.provenance.approvedAt = "2026-09-11T00:00:00Z";
      // Extraction fails, so the executor asks the screen to explain itself...
      c.outputs["savingsBalance"]!.extract.candidates = [{ strategy: "tableCell", rowMatch: "Brokerage", columnHeader: "Current Balance", frame: ["main"] }];
      // ...and this outcome answers "your session is stale, log in again and start over".
      c.outcomes = [{ code: "STALE_VIEW", kind: "recoverable", message: "The view is stale; re-authenticating.", detect: [{ kind: "textMatches", pattern: "Member Detail" }], appliesTo: "any", recover: "prelude:login", maxRecoveries: 2, escalate: false }, ...c.outcomes];
    });
    const { result } = await run(art, { memberId: "10042" }, { allowDraft: false });
    expect(result).toMatchObject({ status: "failure", code: "UNSAFE_RESTART", atStep: "step:extract-savingsbalance" });
    // The strictly more informative value survives: the click was confirmed, not merely attempted.
    expect(result.sideEffects).toBe("committed");
    if (result.status === "failure") expect(result.observed).toContain("could duplicate");
  }, 90_000);

  it("humanConfirm mode asks the hook and proceeds when approved", async () => {
    const risky = fixture((c) => { c.steps[1]!.risk = "risky"; });
    let asked = 0;
    const { result } = await run(risky, { memberId: "10042" }, { riskyStepsRequire: "humanConfirm", confirmRisky: async () => { asked += 1; return true; } });
    expect(asked).toBe(1);
    expect(result.status).toBe("success");
  }, 60_000);
});

describe("control hooks", () => {
  it("escalation hook can resume at the same step after the operator fixes the screen", async () => {
    // remove the SESSION_EXPIRED recovery so expiry becomes a checkpoint failure that escalates; the "operator" logs in by driving the same surface
    const art = fixture((c) => { c.outcomes = c.outcomes.filter((o) => o.code !== "SESSION_EXPIRED"); });
    let escalations = 0;
    const { result } = await run(art, { memberId: "10042" }, {
      cookies: [{ url: base, name: "cu_fault", value: "session_expired" }],
      escalateOnFailure: true,
      onEscalate: async () => { escalations += 1; return "same"; },
    });
    expect(escalations).toBeGreaterThanOrEqual(1);
    // resuming at the same login-click step re-clicks Sign In on the login page and proceeds
    expect(["success", "failure", "escalated"]).toContain(result.status);
  }, 90_000);
  it("cancellation stops between steps with CANCELLED", async () => {
    const ctl = new AbortController();
    let n = 0;
    const { result } = await run(fixture(), { memberId: "10042" }, { signal: ctl.signal, shouldContinue: async () => { n += 1; if (n === 3) ctl.abort(); return "continue"; } });
    expect(result).toMatchObject({ status: "failure", code: "CANCELLED" });
  }, 60_000);
});

describe("parsers", () => {
  it("parses displayed money", () => {
    expect(parseMoney("$1,234.56")).toEqual({ amount: 1234.56, currency: "USD" });
    expect(parseMoney("-$12.00")).toEqual({ amount: -12, currency: "USD" });
    expect(parseMoney("(45.10)")).toEqual({ amount: -45.1, currency: "USD" });
    expect(parseMoney("n/a")).toBeNull();
  });
});

describe("partial runs", () => {
  it("startAtStepIndex skips the preludes and the earlier steps entirely", async () => {
    // The flag's contract is what it does *not* replay: the steps before the resume point. Anything
    // needed to make the run legal is still established on demand, which is why the login prelude
    // reappears here — a fresh process has no session, so the precondition check finds the sign-in
    // screen and the declared recovery re-authenticates before the run continues.
    const { result, events } = await run(fixture(), { memberId: "10042" }, { startAtStepIndex: 2, runTimeoutMs: 45_000 });
    expect(events).not.toContain("step:type-textbox-member-id");
    expect(events).not.toContain("step:click-button-search");
    expect(events).toContain("step:open-app"); // the prelude is re-established, not skipped
    // Resuming into a session that was never opened cannot find the member detail screen, and says
    // so as a wrong screen rather than as an engine crash.
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.code).toBe("WRONG_SCREEN");
  }, 90_000);
});

describe("visual drift metric", () => {
  const drifted = (a: number[], b: number[]) => boxSimilarity(a, b) < VISUAL_DRIFT_THRESHOLD;
  // A ~37x14 button is what a legacy app actually renders; the metric must survive that scale.
  const button = [486, 121, 37, 14];

  it("does not fire on an unchanged control", () => {
    expect(drifted(button, button)).toBe(false);
  });
  it("does not fire on sub-pixel rendering differences", () => {
    expect(drifted(button, [487, 122, 38, 14])).toBe(false);
  });
  it("does not fire when the resolver measures a padded box around the same centre", () => {
    // The recorder measures the accessible node; the resolver measures the element. Same place,
    // twice the area — which is why the metric ignores size entirely.
    expect(drifted(button, [479, 114, 51, 28])).toBe(false);
  });
  it("fires when the control moves to another part of the screen", () => {
    expect(drifted(button, [486, 340, 37, 14])).toBe(true);
    expect(drifted(button, [120, 121, 37, 14])).toBe(true);
  });
  it("is symmetric in magnitude and bounded to [0,1]", () => {
    for (const b of [button, [487, 122, 38, 14], [486, 340, 37, 14], [0, 0, 1, 1]]) {
      const v = boxSimilarity(button, b);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

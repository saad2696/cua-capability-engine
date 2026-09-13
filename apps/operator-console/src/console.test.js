/**
 * The console's two pieces of real logic.
 *
 * Most of this app is markup, and markup is better checked by looking at it. These two are not:
 * one decides what an operator's click means in the live browser, and the other decides what the
 * run's step list says happened. Both are pure functions over inputs the engine produces, so both
 * can drift silently when the engine's event shape changes.
 */
import { describe, expect, it } from "vitest";
import { toPageCoordinates } from "./components/LiveViewport.jsx";
import { buildSteps } from "./components/StepProgress.jsx";

describe("click coordinates", () => {
  // The live view renders a 1280x800 screenshot at whatever width the layout gives it. Every
  // coordinate bug in this project has come from a scale factor applied twice, so this is the one
  // line worth pinning: a click at CSS pixel x means page pixel x * (natural width / rendered width).
  const rect = { left: 100, top: 50, width: 640 };

  it("maps a click through the image's scale factor", () => {
    // Rendered at half size, so a click 100px into the image is 200px into the page.
    expect(toPageCoordinates({ clientX: 200, clientY: 150 }, rect, 1280)).toEqual({ x: 200, y: 200 });
  });

  it("subtracts the image's position on the page before scaling, not after", () => {
    // A click on the image's top-left corner is the page's origin, whatever the offset.
    expect(toPageCoordinates({ clientX: 100, clientY: 50 }, rect, 1280)).toEqual({ x: 0, y: 0 });
  });

  it("is the identity when the image is rendered at its natural size", () => {
    expect(toPageCoordinates({ clientX: 420, clientY: 250 }, { left: 0, top: 0, width: 1280 }, 1280)).toEqual({ x: 420, y: 250 });
  });

  it("falls back to no scaling before the image has loaded", () => {
    // naturalWidth is 0 until the first frame arrives; scaling by zero would send every click to
    // the origin, which is worse than sending it to the wrong place visibly.
    expect(toPageCoordinates({ clientX: 200, clientY: 150 }, rect, 0)).toEqual({ x: 100, y: 100 });
  });
});

describe("what the step list says happened", () => {
  const ev = (type, stepId, rest = {}) => ({ type, stepId, ...rest });

  it("keeps the engine's own order and phase", () => {
    const steps = buildSteps([
      ev("act", "step:open-app", { phase: "prelude", action: "navigate", ok: true }),
      ev("verify", "step:open-app", { phase: "prelude", ok: true }),
      ev("act", "step:search", { phase: "main", action: "click", ok: true }),
    ]);
    expect(steps.map((s) => [s.id, s.phase, s.status])).toEqual([
      ["step:open-app", "prelude", "passed"],
      ["step:search", "main", "running"],
    ]);
  });

  it("a confirmed assertion passes the step; a failed one does not", () => {
    expect(buildSteps([ev("verify", "step:a", { ok: true, assertion: "urlMatches" })])[0].status).toBe("passed");
    const failed = buildSteps([ev("verify", "step:a", { ok: false, assertion: "urlMatches ^/search" })])[0];
    expect(failed.status).toBe("running");
    expect(failed.notes.join(" ")).toContain("urlMatches ^/search");
  });

  it("a recovery marks the step recovered rather than failed", () => {
    const [step] = buildSteps([
      ev("act", "step:a", { action: "click", ok: false, error: "dialog open" }),
      ev("detect", "step:a", { code: "SESSION_EXPIRED", kind: "recoverable" }),
      ev("recover", "step:a", { code: "SESSION_EXPIRED", recovery: "prelude:login", attempt: 1 }),
    ]);
    expect(step.status).toBe("recovered");
    expect(step.notes.join(" ")).toContain("prelude:login");
  });

  it("a failure outcome and an escalation both fail the step, with the reason kept", () => {
    const [detected] = buildSteps([ev("detect", "step:a", { code: "UNKNOWN_DIALOG", kind: "failure" })]);
    expect(detected.status).toBe("failed");
    const [escalated] = buildSteps([ev("escalate", "step:a", { reason: "OUTCOME_ESCALATE" })]);
    expect(escalated.status).toBe("failed");
    expect(escalated.notes.join(" ")).toContain("OUTCOME_ESCALATE");
  });

  it("an extraction passes the step and shows the value", () => {
    const [step] = buildSteps([ev("extract", "step:read", { output: "savingsBalance", parsed: { amount: 1234.56, currency: "USD" }, strategy: "tableCell" })]);
    expect(step.status).toBe("passed");
    expect(step.notes.join(" ")).toContain("1234.56");
  });

  it("ignores events that belong to no step", () => {
    expect(buildSteps([{ type: "run_started" }, { type: "control_change", from: "none", to: "replay" }])).toEqual([]);
  });
});

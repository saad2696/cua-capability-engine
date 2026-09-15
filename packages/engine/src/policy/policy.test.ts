/**
 * Policy tests.
 *
 * The risk cases use the literal strings the mock app renders, copied from
 * apps/target-app/src/views/pages.ts, not paraphrases of them. An earlier version of the classifier
 * matched `^\s*(open account)\b`, which passes a test written against "Open Account" and fails
 * against the control the app actually draws. Reading the button text out of the app is the only
 * version of this test that can catch that.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyEnforcedSurface, PolicyViolation } from "./PolicyEnforcedSurface.js";
import { basicPolicy, policyGate } from "./basic.js";
import { riskClassifier } from "./risk.js";
import { DEFAULT_POLICY, loadPolicy, parsePolicy } from "./schema.js";
import { PolicyLoadError, runPolicy } from "./load.js";
import type { Observation } from "../surface/types.js";
import type { Decision } from "../llm/types.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

const classify = riskClassifier(DEFAULT_POLICY.risk);

const obs = (over: Partial<Observation> = {}): Observation => ({
  at: new Date().toISOString(),
  url: "http://localhost:4100/member/10042",
  title: "Member",
  frames: [{ path: [], url: "http://localhost:4100/member/10042", offset: { x: 0, y: 0 } }],
  landmarks: [],
  elements: [],
  screenshotPng: Buffer.alloc(0),
  rawScreenshotPng: Buffer.alloc(0),
  viewport: { width: 1280, height: 800 },
  ...over,
});

const el = (over: Partial<Observation["elements"][number]>) => ({
  index: 0,
  role: "button",
  name: "",
  bbox: [0, 0, 10, 10] as [number, number, number, number],
  frame: [],
  enabled: true,
  focused: false,
  ...over,
});

const decision = (tool: string, args: Record<string, unknown> = {}): Decision =>
  ({ tool, args, reasoning: "" }) as Decision;

describe("policy document", () => {
  it("the checked-in policy.yaml is valid and matches the built-in defaults", () => {
    // Equality is the weaker half of the claim. The test below is the half that matters: editing
    // the file has to change what a run does, or the file is documentation pretending to be a
    // control. This one only guards against the two drifting apart.
    const loaded = loadPolicy(join(REPO_ROOT, "policy.yaml"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Drift between the file an operator reads and the defaults the code falls back to would mean
    // two different policies depending on the working directory.
    expect(loaded.policy).toEqual(DEFAULT_POLICY);
  });

  it("a missing file falls back to the defaults and says so", () => {
    const loaded = loadPolicy(join(REPO_ROOT, "no-such-policy.yaml"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.source).toBe("built-in defaults");
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const bad = { ...DEFAULT_POLICY, blockedUrlPatters: ["/admin"] };
    const res = parsePolicy(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(JSON.stringify(res.issues)).toMatch(/unrecognized|blockedUrlPatters/i);
  });

  it("rejects an origin that is not an absolute origin and a pattern that is not a regex", () => {
    expect(parsePolicy({ ...DEFAULT_POLICY, allowedOrigins: ["localhost:4100"] }).ok).toBe(false);
    expect(parsePolicy({ ...DEFAULT_POLICY, blockedUrlPatterns: ["("] }).ok).toBe(false);
  });

  it("refuses to claim screenshots are masked when they are not", () => {
    const res = parsePolicy({ ...DEFAULT_POLICY, redaction: { ...DEFAULT_POLICY.redaction, maskEvidenceScreenshots: true } });
    expect(res.ok).toBe(false);
  });
});

describe("the policy file governs a run, not just the docs", () => {
  const dirs: string[] = [];
  const withPolicy = (yaml: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "cua-policy-"));
    dirs.push(dir);
    writeFileSync(join(dir, "policy.yaml"), yaml);
    return join(dir, "policy.yaml");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const base = readFileSync(join(REPO_ROOT, "policy.yaml"), "utf8");

  it("a path blocked only in the file is blocked in the run", () => {
    const path = withPolicy(base.replace('  - "/admin"', '  - "/admin"\n  - "/statements"'));
    const { gate } = runPolicy({ origins: ["http://localhost:4100"], path });
    expect(gate.allowRequest("http://localhost:4100/statements/2024")).toBe(false);
    // ...and is allowed by the unedited file, so the test is measuring the edit and not a typo.
    expect(runPolicy({ origins: ["http://localhost:4100"] }).gate.allowRequest("http://localhost:4100/statements/2024")).toBe(true);
  });

  it("a term added to the file makes a previously safe control risky", () => {
    const path = withPolicy(base.replace('    - "confirm"', '    - "confirm"\n    - "enrol"'));
    const { gate } = runPolicy({ origins: ["http://localhost:4100"], path });
    const o = obs({ elements: [el({ name: "Enrol in Online Banking" })] });
    expect(gate.check(decision("click", { index: 0 }), o).risk).toBe("risky");
    expect(basicPolicy({ allowedOrigins: ["http://localhost:4100"] }).check(decision("click", { index: 0 }), o).risk).toBe("safe");
  });

  it("onRisky: block in the file refuses instead of escalating", () => {
    const path = withPolicy(base.replace("  onRisky: escalate", "  onRisky: block"));
    const { gate, policy } = runPolicy({ origins: ["http://localhost:4100"], path });
    expect(policy.discovery.onRisky).toBe("block");
    expect(gate.check(decision("click", { index: 0 }), obs({ elements: [el({ name: "Open Account" })] })).allow).toBe(false);
  });

  it("the run's own origins override the file, which cannot know an ephemeral test port", () => {
    const { gate } = runPolicy({ origins: ["http://127.0.0.1:53127"] });
    expect(gate.allowRequest("http://127.0.0.1:53127/search")).toBe(true);
    expect(gate.allowRequest("http://localhost:4100/search")).toBe(false);
    // The blocked paths still come from the document.
    expect(gate.allowRequest("http://127.0.0.1:53127/__faults")).toBe(false);
  });

  it("an invalid policy stops the run rather than falling back to defaults", () => {
    const path = withPolicy("version: 1\nallowedOrigins: []\n");
    expect(() => runPolicy({ origins: ["http://localhost:4100"], path })).toThrow(PolicyLoadError);
  });
});

describe("risk classification against the real target app", () => {
  const pages = readFileSync(join(REPO_ROOT, "apps/target-app/src/views/pages.ts"), "utf8");
  /** Pull a label out of the app source so the test cannot drift from what is rendered. */
  const labelFrom = (re: RegExp): string => {
    const m = pages.match(re);
    if (!m?.[1]) throw new Error(`the target app no longer renders a control matching ${re}`);
    return m[1];
  };

  it("the committing control — the one that actually opens the account — is risky on the input discovery really produces", () => {
    const label = labelFrom(/submitButton\("(Open Account)"\)/);
    // Exactly the subject `basic.ts` builds from an ElementSummary: name, role, page URL. No
    // formAction, because ElementSummary has no such field and nothing in production fills it in.
    // Feeding one here would prove the classifier works on an input it never receives — the same
    // mistake as writing "Open Account" from memory when the app renders something else.
    const v = classify.classify({ action: "click", targetRole: "button", targetName: label, pageUrl: "http://localhost:4100/member/10042/subaccount/new" });
    expect(v.risk).toBe("risky");
    expect(v.sideEffect).toBe("committed");
    // The button text alone carries it, which is the claim worth making: it does not depend on a
    // URL that happens to contain /open.
    expect(v.reasons).toEqual(['the control is labelled "Open Account"']);
  });

  it("the URL signal fires for navigation and for Enter, the two subjects that carry a destination", () => {
    // A click's destination is not knowable before the click, so `irreversibleUrlPatterns` is live
    // for `navigate` and, via the page URL, for Enter inside a form. This is the documented reach
    // of that rule, not an accident: the network layer catches what a click actually requests.
    expect(classify.classify({ action: "navigate", url: "http://localhost:4100/member/10042/subaccount/open" }).risk).toBe("risky");
    expect(classify.classify({ action: "press", key: "Enter", focusInForm: true, pageUrl: "http://localhost:4100/member/10042/subaccount/confirm" }).risk).toBe("risky");
    // ...but not on an ordinary page, where Enter is just a search.
    expect(classify.classify({ action: "press", key: "Enter", focusInForm: true, pageUrl: "http://localhost:4100/search" }).sideEffect).toBe("possible");
  });

  it("does not re-flag the page reached *after* a commit", () => {
    // /member/:id/subaccount/open matches the irreversible URL list, and the confirmation page is
    // served from it. Clicking "Return to Member" there must not read as a second commit — which is
    // why the page-URL fallback is scoped to Enter and never applied to clicks.
    const v = classify.classify({ action: "click", targetRole: "link", targetName: "Return to Member", pageUrl: "http://localhost:4100/member/10042/subaccount/open" });
    expect(v.risk).toBe("safe");
    expect(v.sideEffect).toBe("none");
  });

  it("the link that merely opens the form is not risky", () => {
    const label = labelFrom(/jsLink\("(Open New Sub-Account)"/);
    const v = classify.classify({ action: "click", targetRole: "link", targetName: label, url: "http://localhost:4100/member/10042/subaccount/new" });
    expect(v.risk).toBe("safe");
    expect(v.sideEffect).toBe("none");
  });

  it("the validation submit is a possible side effect, not an escalation", () => {
    const label = labelFrom(/submitButton\("(Continue)"\)/);
    const v = classify.classify({ action: "click", targetRole: "button", targetName: label, isSubmit: true, formAction: "/member/10042/subaccount/new", pageUrl: "http://localhost:4100/member/10042" });
    expect(v.risk).toBe("safe");
    expect(v.sideEffect).toBe("possible");
  });

  it("searching and reading are safe", () => {
    expect(classify.classify({ action: "click", targetRole: "button", targetName: "Search" }).risk).toBe("safe");
    expect(classify.classify({ action: "extract", targetName: "Confirm" }).risk).toBe("safe");
    expect(classify.classify({ action: "scroll" }).sideEffect).toBe("none");
  });

  it("a substring is not a word: 'Repost' does not match 'post'", () => {
    expect(classify.classify({ action: "click", targetName: "Reposting Guide" }).risk).toBe("safe");
    expect(classify.classify({ action: "click", targetName: "Post Transaction" }).risk).toBe("risky");
  });

  it("Enter inside a form is a submit; Enter elsewhere is not", () => {
    expect(classify.classify({ action: "press", key: "Enter", focusInForm: true }).sideEffect).toBe("possible");
    expect(classify.classify({ action: "press", key: "Enter", focusInForm: false }).sideEffect).toBe("none");
  });

  it("accepting a confirm dialog is risky; cancelling one never is", () => {
    // The mock app's point of no return is a native confirm(), not a button: the click that raises
    // it fails with the dialog still open, and the accept is what actually commits. Verified
    // against the real app — see the G2 probe in REPORT section 3.
    const msg = "Open this sub-account now? This action cannot be undone.";
    const accept = classify.classify({ action: "dismiss_dialog", accept: true, dialogMessage: msg });
    expect(accept.risk).toBe("risky");
    expect(accept.sideEffect).toBe("committed");
    expect(accept.reasons.join(" ")).toContain("cannot be undone");

    const cancel = classify.classify({ action: "dismiss_dialog", accept: false, dialogMessage: msg });
    expect(cancel.risk).toBe("safe");
    expect(cancel.sideEffect).toBe("none");
  });

  it("the gate reads the pending dialog off the observation", () => {
    const gate = basicPolicy({ allowedOrigins: ["http://localhost:4100"] });
    const o = obs({ dialog: { type: "confirm", message: "Open this sub-account now? This action cannot be undone." } });
    expect(gate.check(decision("dismiss_dialog", { accept: true }), o)).toMatchObject({ allow: true, risk: "risky" });
    expect(gate.check(decision("dismiss_dialog", { accept: false }), o).risk).toBe("safe");
  });

  it("dismiss_dialog is a permitted action — a name mismatch would read as 'tool not permitted'", () => {
    const gate = basicPolicy({ allowedOrigins: ["http://localhost:4100"] });
    expect(gate.allowedTools.has("dismiss_dialog")).toBe(true);
  });

  it("a model-declared irreversible step is honoured even when nothing else matches", () => {
    const v = classify.classify({ action: "click", targetName: "Go", modelFlagged: true });
    expect(v.risk).toBe("risky");
  });
});

describe("decision-time gate", () => {
  const gate = basicPolicy({ allowedOrigins: ["http://localhost:4100"] });

  it("blocks a tool that is not on the list", () => {
    expect(gate.check(decision("eval", {}), obs()).allow).toBe(false);
  });

  it("blocks navigation off the allowlist and inside a blocked path", () => {
    expect(gate.check(decision("navigate", { url: "https://example.com/" }), obs()).allow).toBe(false);
    expect(gate.check(decision("navigate", { url: "http://localhost:4100/__faults" }), obs()).allow).toBe(false);
    expect(gate.check(decision("navigate", { url: "http://localhost:4100/search" }), obs()).allow).toBe(true);
  });

  it("flags a risky click as allowed-but-risky under onRisky: escalate", () => {
    const o = obs({ elements: [el({ name: "Open Account" })] });
    const v = gate.check(decision("click", { index: 0 }), o);
    expect(v).toMatchObject({ allow: true, risk: "risky" });
    expect(v.reason).toContain("Open Account");
  });

  it("refuses the same click under onRisky: block", () => {
    const strict = policyGate({ ...DEFAULT_POLICY, discovery: { onRisky: "block" } });
    const o = obs({ elements: [el({ name: "Open Account" })] });
    expect(strict.check(decision("click", { index: 0 }), o)).toMatchObject({ allow: false, risk: "risky" });
  });
});

describe("surface boundary gate", () => {
  const gate = basicPolicy({ allowedOrigins: ["http://localhost:4100"] });

  /** The smallest Surface that records what reached it. */
  const stubSurface = () => {
    const calls: string[] = [];
    const s = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => {
        if (prop === "kind") return "web";
        return (...args: unknown[]) => {
          calls.push(`${prop}:${JSON.stringify(args[0] ?? null)}`);
          return Promise.resolve(prop === "screenshot" ? Buffer.alloc(0) : undefined);
        };
      },
    });
    return { calls, surface: s as never };
  };

  it("stops the engine from opening a URL the decision gate would have refused", async () => {
    const { calls, surface } = stubSurface();
    const s = new PolicyEnforcedSurface(surface, { gate });
    await expect(s.open("https://evil.example/")).rejects.toBeInstanceOf(PolicyViolation);
    await expect(s.act({ kind: "navigate", url: "http://localhost:4100/__faults" })).rejects.toBeInstanceOf(PolicyViolation);
    expect(calls).toEqual([]);
  });

  it("lets an allowed URL through", async () => {
    const { calls, surface } = stubSurface();
    const s = new PolicyEnforcedSurface(surface, { gate });
    await s.open("http://localhost:4100/login");
    expect(calls).toEqual(['open:"http://localhost:4100/login"']);
  });

  it("does not block a human, but records the override", async () => {
    const overrides: string[] = [];
    const { calls, surface } = stubSurface();
    const s = new PolicyEnforcedSurface(surface, {
      gate,
      controller: () => "human",
      onOverride: (by, what, reason) => overrides.push(`${by}/${what}/${reason}`),
    });
    await s.open("https://example.com/help");
    expect(calls).toEqual(['open:"https://example.com/help"']);
    expect(overrides[0]).toContain("human/open/https://example.com/help");
  });

  it("reads are never gated — the console keeps rendering while the engine is stopped", async () => {
    const { calls, surface } = stubSurface();
    const s = new PolicyEnforcedSurface(surface, { gate });
    await s.observe();
    await s.screenshot();
    await s.visibleText();
    expect(calls.length).toBe(3);
  });
});

describe("network layer", () => {
  const gate = basicPolicy({ allowedOrigins: ["http://localhost:4100"] });
  it("allows the browser's own scratch surfaces but no third-party origin", () => {
    expect(gate.allowRequest("about:blank")).toBe(true);
    expect(gate.allowRequest("http://localhost:4100/style.css")).toBe(true);
    expect(gate.allowRequest("https://cdn.example.com/a.js")).toBe(false);
    expect(gate.allowRequest("not a url")).toBe(false);
  });
});

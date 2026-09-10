import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../../../apps/target-app/src/server.js";
import { PlaywrightSurface } from "./playwright/PlaywrightSurface.js";
import type { Locator } from "@cua/schema";

let server: Server;
let base: string;
let surface: PlaywrightSurface;

beforeAll(async () => {
  process.env["TARGET_FAULT_SLOW_MS"] = "200";
  const { app } = createApp({ credentials: { user: "demo", password: "demo" } });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  surface = new PlaywrightSurface({ headless: true });
  await surface.open(`${base}/`);
}, 60_000);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const byName = (els: { role: string; name: string }[], role: string, name: string) => els.find((e) => e.role === role && e.name === name);

describe("perception across a frameset", () => {
  it("sees interactive elements inside frames with frame paths and page-coordinate boxes", async () => {
    const obs = await surface.observe();
    expect(obs.frames.map((f) => f.path.join("/"))).toEqual(["", "nav", "main"]);
    const user = byName(obs.elements, "textbox", "User Name");
    const pass = byName(obs.elements, "textbox", "Password");
    const signIn = byName(obs.elements, "button", "Sign In");
    expect(user?.frame).toEqual(["main"]);
    expect(pass?.frame).toEqual(["main"]);
    expect(signIn?.frame).toEqual(["main"]);
    expect(user!.bbox[0]).toBeGreaterThan(170); // right of the 170px nav frame => page coordinates
    expect(byName(obs.elements, "link", "Sign In")?.frame).toEqual(["nav"]);
    expect(obs.screenshotPng.length).toBeGreaterThan(1000);
    expect(obs.screenshotPng.equals(obs.rawScreenshotPng)).toBe(false); // marks were drawn
  });

  it("redacts values of sensitive fields in the element list", async () => {
    let obs = await surface.observe();
    await surface.act({ kind: "type", target: { index: byName(obs.elements, "textbox", "Password")!.index }, text: "demo" });
    obs = await surface.observe();
    expect(byName(obs.elements, "textbox", "Password")?.value).toBe("[redacted]");
  });
});

describe("acting by element index", () => {
  it("logs in with type + click and lands on Member Search", async () => {
    let obs = await surface.observe();
    const r1 = await surface.act({ kind: "type", target: { index: byName(obs.elements, "textbox", "User Name")!.index }, text: "demo" });
    expect(r1.ok).toBe(true);
    const r2 = await surface.act({ kind: "click", target: { index: byName(obs.elements, "button", "Sign In")!.index } });
    expect(r2.ok).toBe(true);
    obs = await surface.observe();
    expect(byName(obs.elements, "textbox", "Member ID")).toBeTruthy();
    expect(await surface.landmarkVisible("cell", "Member Search", ["main"])).toBe(true);
    expect(surface.frameUrl(["main"])).toContain("/search");
    expect(byName(obs.elements, "link", "Sign Out")?.frame).toEqual(["nav"]); // frameset reloaded after login
  });
});

describe("locator capture and resolution", () => {
  let captured: Locator;

  it("captures ordered candidates with a rationale for the Member ID field", async () => {
    const obs = await surface.observe();
    captured = await surface.captureLocator(byName(obs.elements, "textbox", "Member ID")!.index);
    const strategies = captured.candidates.map((c) => c.strategy);
    expect(strategies[0]).toBe("role");
    expect(strategies).toContain("label");
    expect(strategies).toContain("css");
    expect(strategies.at(-1)).toBe("visual");
    expect(captured.frame).toEqual(["main"]);
    expect(captured.rationale).toMatch(/accessibility tree/);
    const css = captured.candidates.find((c) => c.strategy === "css");
    expect(css && "selector" in css && css.selector).toBe('input[name="q"]');
    expect(captured.recordedBBox).toBeTruthy();
  });

  it("resolves via the primary strategy", async () => {
    const r = await surface.resolve(captured);
    expect(r?.strategy).toBe("role");
    expect(r?.candidateIndex).toBe(0);
  });

  it("falls back in order when earlier candidates miss, reporting which strategy matched", async () => {
    const broken: Locator = {
      ...captured,
      candidates: captured.candidates.map((c) => (c.strategy === "role" ? { ...c, name: "Account Holder #" } : c.strategy === "label" ? { ...c, text: "Account Holder #" } : c)),
    };
    const r = await surface.resolve(broken);
    expect(r?.strategy).toBe("css");
    expect(r?.attempts).toBe(3);
  });

  it("returns null when nothing matches and the visual anchor moved", async () => {
    const nothing: Locator = {
      frame: ["main"],
      rationale: "test",
      candidates: [
        { strategy: "role", role: "textbox", name: "Nope", exact: true, confidence: 0.9 },
        { strategy: "css", selector: "input[name='zzz']", confidence: 0.4 },
        { strategy: "visual", bbox: [900, 700, 20, 20], viewport: [1024, 768], anchorText: "Member ID", confidence: 0.3 },
      ],
    };
    expect(await surface.resolve(nothing)).toBeNull();
  });

  it("acts through a locator and reports the resolution", async () => {
    const r = await surface.act({ kind: "type", target: { locator: captured }, text: "10042" });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(r.resolved?.strategy).toBe("role");
    const obs = await surface.observe();
    const search = byName(obs.elements, "button", "Search")!;
    const clickLoc = await surface.captureLocator(search.index);
    expect(clickLoc.candidates.some((c) => c.strategy === "text" && "text" in c && c.text === "Search"), JSON.stringify(clickLoc)).toBe(true);
    await surface.act({ kind: "click", target: { locator: clickLoc } });
    expect(await surface.landmarkVisible("cell", "Member Detail", ["main"])).toBe(true);
    expect(surface.frameUrl(["main"])).toMatch(/\/member\/10042$/);
  });

  it("reads text by locator and visible text by frame", async () => {
    const text = await surface.visibleText(["main"]);
    expect(text).toContain("Alex Sample");
    expect(text).toContain("$1,234.56");
    const nav = await surface.visibleText(["nav"]);
    expect(nav).toContain("Sign Out");
    expect(nav).not.toContain("Alex");
  });
});

describe("dialogs are observed, not swallowed", () => {
  it("reports a pending alert and lets the caller dismiss it", async () => {
    await surface.act({ kind: "navigate", url: `${base}/search?fault=unexpected_dialog` });
    // the alert fires on load; give it a moment
    await new Promise((r) => setTimeout(r, 300));
    const obs = await surface.observe();
    expect(obs.dialog?.type).toBe("alert");
    expect(obs.dialog?.message).toContain("System maintenance");
    const blocked = await surface.act({ kind: "click", target: { point: { x: 10, y: 10 } } });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("dialog open");
    const dismissed = await surface.act({ kind: "dismissDialog", accept: true });
    expect(dismissed.ok).toBe(true);
    const after = await surface.observe();
    expect(after.dialog).toBeUndefined();
    expect(byName(after.elements, "textbox", "Member ID")).toBeTruthy();
  });
});

describe("network allowlist hook", () => {
  it("blocks navigation outside the allowlist", async () => {
    const guarded = new PlaywrightSurface({ headless: true, allowRequest: (url) => url.startsWith(base) });
    try {
      await guarded.open(`${base}/`);
      await expect(guarded.open("http://example.com/")).rejects.toThrow(/blocked by policy/);
      const r = await guarded.act({ kind: "navigate", url: "http://example.com/" });
      expect(r.ok).toBe(false);
    } finally {
      await guarded.close();
    }
  }, 30_000);
});

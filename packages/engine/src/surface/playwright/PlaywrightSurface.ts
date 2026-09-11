/**
 * Web implementation of Surface on Playwright/Chromium.
 *
 * Perception: accessibility tree over CDP, per frame, plus a marked screenshot.
 * Action: coordinate clicks and element handles found by point, so acting works the way an
 * operator does; typing prefers fill-and-verify with a keyboard fallback.
 * Dialogs are surfaced, never auto-dismissed. New pages are reported to a policy hook.
 */
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type ElementHandle, type Frame, type Page } from "playwright";
import type { ElementSummary, ExtractionCandidate, Locator } from "@cua/schema";
import type { ActResult, DialogInfo, FrameInfo, Observation, Resolved, Surface, SurfaceAction, Target, TextReadResult } from "../types.js";
import { captureLocatorFor } from "./capture.js";
import { extractByCandidate } from "./extract.js";
import { findFrame, frameOffset, allFrames } from "./frames.js";
import { withMarks } from "./marks.js";
import { perceiveElements, perceiveFrames, perceiveLandmarks } from "./perception.js";
import { resolveLocator, type ResolvedHandle } from "./resolver.js";

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Called before any navigation request; return false to abort it (allowlist enforcement). */
  allowRequest?: (url: string, isNavigation: boolean) => boolean;
  slowMo?: number;
  /** Chromium user data dir (a persistent profile makes the browser reusable across sessions). */
  tracePath?: string;
}

const SETTLE_MS = 150;

export class PlaywrightSurface implements Surface {
  readonly kind = "web" as const;
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private cdp!: CDPSession;
  private lastObservation?: Observation;
  private dialog: { info: DialogInfo; handle: Dialog } | undefined;
  private lastStatus: number | undefined;
  private pageSwitchHandler?: (url: string) => "adopt" | "close";
  private readonly viewport: { width: number; height: number };

  constructor(private readonly opts: PlaywrightSurfaceOptions = {}) {
    this.viewport = opts.viewport ?? { width: 1024, height: 768 };
  }

  /** Access for advanced callers (session streaming). */
  get pw(): { page: Page; context: BrowserContext } {
    return { page: this.page, context: this.context };
  }

  async open(url: string): Promise<void> {
    if (!this.browser) await this.launch();
    if (this.opts.allowRequest && !this.opts.allowRequest(url, true)) throw new Error(`navigation to ${url} blocked by policy`);
    // "commit" rather than "load": a dialog raised during load would block the load event forever.
    const resp = await this.page.goto(url, { waitUntil: "commit" });
    this.lastStatus = resp?.status();
    await this.waitForLoadOrDialog(8000);
    await this.settle();
  }

  private async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true, ...(this.opts.slowMo ? { slowMo: this.opts.slowMo } : {}) });
    this.context = await this.browser.newContext({ viewport: this.viewport, deviceScaleFactor: 1 });
    if (this.opts.tracePath) await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.page = await this.context.newPage();
    await this.attach(this.page);
    this.context.on("page", async (p) => {
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      const verdict = this.pageSwitchHandler?.(p.url()) ?? "close";
      if (verdict === "adopt") {
        await this.attach(p);
      } else await p.close().catch(() => {});
    });
  }

  private async attach(page: Page): Promise<void> {
    this.page = page;
    this.cdp = await this.context.newCDPSession(page);
    await this.cdp.send("Accessibility.enable").catch(() => {});
    await this.cdp.send("DOM.enable").catch(() => {});
    page.on("dialog", (d) => {
      this.dialog = { info: { type: d.type() as DialogInfo["type"], message: d.message(), defaultValue: d.defaultValue() }, handle: d };
    });
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) this.lastStatus = r.status();
    });
    if (this.opts.allowRequest) {
      await page.route("**/*", (route) => {
        const req = route.request();
        if (this.opts.allowRequest!(req.url(), req.isNavigationRequest())) return route.continue();
        return route.abort("blockedbyclient");
      });
    }
  }

  /** Resolve when the page reaches "load" or a dialog opens, whichever comes first. */
  private async waitForLoadOrDialog(timeoutMs: number): Promise<void> {
    const loaded = this.page.waitForLoadState("load", { timeout: timeoutMs }).then(() => "load" as const).catch(() => "timeout" as const);
    const dialog = new Promise<"dialog" | "timeout">((res) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (this.dialog) { clearInterval(iv); res("dialog"); }
        else if (Date.now() - started > timeoutMs) { clearInterval(iv); res("timeout"); }
      }, 50);
    });
    await Promise.race([loaded, dialog]);
  }

  private async settle(): Promise<void> {
    if (this.dialog) return;
    await this.page.waitForTimeout(SETTLE_MS);
    for (const f of allFrames(this.page)) await f.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
  }

  pendingDialog(): DialogInfo | undefined {
    return this.dialog?.info;
  }

  /**
   * Serialises observation against plain screenshots.
   *
   * `observe` injects the numbered marks into the page, takes its picture, then removes them. A
   * frame streamed to a watching console at the wrong instant catches those marks half-drawn, which
   * looks like the application is broken. Anything that photographs the page waits its turn.
   */
  private marking: Promise<unknown> = Promise.resolve();

  private async serialised<T>(fn: () => Promise<T>): Promise<T> {
    const mine = this.marking.then(fn, fn);
    this.marking = mine.catch(() => undefined);
    return mine;
  }

  async observe(): Promise<Observation> {
    const at = new Date().toISOString();
    if (this.dialog) {
      // scripts cannot run while a dialog blocks the page; report the dialog on top of the last observation
      const base = this.lastObservation;
      const obs: Observation = {
        at, url: this.page.url(), title: base?.title ?? "", frames: base?.frames ?? [], landmarks: base?.landmarks ?? [], elements: base?.elements ?? [],
        screenshotPng: base?.screenshotPng ?? Buffer.alloc(0), rawScreenshotPng: base?.rawScreenshotPng ?? Buffer.alloc(0),
        viewport: this.viewport, dialog: this.dialog.info, ...(this.lastStatus !== undefined ? { lastHttpStatus: this.lastStatus } : {}),
      };
      return obs;
    }
    const frames = await perceiveFrames(this.page, this.cdp);
    const frameInfos: FrameInfo[] = [];
    for (const f of frames) {
      const pw = findFrame(this.page, f.path);
      frameInfos.push({ path: f.path, url: f.url, offset: pw ? await frameOffset(pw) : { x: 0, y: 0 } });
    }
    const elements = await perceiveElements(this.cdp, frames, this.viewport);
    const landmarks = await perceiveLandmarks(this.cdp, frames, this.viewport);
    const rawScreenshotPng = await this.page.screenshot({ type: "png" });
    const screenshotPng = await this.serialised(() => withMarks(this.page!, elements, () => this.page!.screenshot({ type: "png" })));
    const obs: Observation = {
      at, url: this.page.url(), title: await this.page.title().catch(() => ""), frames: frameInfos, landmarks, elements, screenshotPng, rawScreenshotPng,
      viewport: this.viewport, ...(this.lastStatus !== undefined ? { lastHttpStatus: this.lastStatus } : {}),
    };
    this.lastObservation = obs;
    return obs;
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    if (this.dialog) return this.lastObservation?.rawScreenshotPng ?? Buffer.alloc(0);
    // Waits for any in-flight marked capture, so a streamed frame never shows half-drawn marks.
    return this.serialised(() => this.screenshotNow(opts));
  }

  private async screenshotNow(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    return this.page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
  }

  async readValue(locator: Locator): Promise<string | null> {
    const r = await resolveLocator(this.page, locator);
    if (!r?.pw) return null;
    return r.pw.inputValue({ timeout: 2000 }).catch(() => null);
  }

  async setCookie(url: string, name: string, value: string): Promise<void> {
    if (!this.browser) await this.launch();
    await this.context.addCookies([{ name, value, url }]);
  }

  async reload(frame?: string[]): Promise<void> {
    const f = findFrame(this.page, frame);
    if (f && f !== this.page.mainFrame()) {
      const url = f.url();
      await f.goto(url, { waitUntil: "commit" }).catch(() => {});
    } else {
      await this.page.reload({ waitUntil: "commit" }).catch(() => {});
    }
    await this.waitForLoadOrDialog(8000);
    await this.settle();
  }

  frameUrl(frame?: string[]): string | undefined {
    if (!this.page) return undefined;
    return findFrame(this.page, frame)?.url();
  }

  onPageSwitch(handler: (url: string) => "adopt" | "close"): void {
    this.pageSwitchHandler = handler;
  }

  // ---- targeting ----

  private elementAt(index: number): ElementSummary {
    const el = this.lastObservation?.elements[index];
    if (!el) throw new Error(`no element #${index} in the last observation`);
    return el;
  }

  /** Element handle under a page-coordinate point inside a frame. */
  private async handleAtPoint(frame: Frame, point: { x: number; y: number }): Promise<ElementHandle | null> {
    const off = await frameOffset(frame);
    const h = await frame.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: point.x - off.x, y: point.y - off.y });
    const el = h.asElement();
    if (!el) {
      await h.dispose();
      return null;
    }
    return el;
  }

  private async resolveTarget(target: Target): Promise<{ frame: Frame; point: { x: number; y: number }; handle: ElementHandle | null; resolved?: Resolved; summary?: ElementSummary }> {
    if ("index" in target) {
      const s = this.elementAt(target.index);
      const frame = findFrame(this.page, s.frame);
      if (!frame) throw new Error(`frame ${s.frame.join("/")} not found`);
      const point = { x: s.bbox[0] + s.bbox[2] / 2, y: s.bbox[1] + s.bbox[3] / 2 };
      return { frame, point, handle: await this.handleAtPoint(frame, point), summary: s };
    }
    if ("locator" in target) {
      const r: ResolvedHandle | null = await resolveLocator(this.page, target.locator);
      if (!r) throw new Error("LOCATOR_NOT_FOUND");
      const handle = r.pw ? await r.pw.elementHandle({ timeout: 2000 }).catch(() => null) : await this.handleAtPoint(r.frameRef, r.point);
      const { frameRef, pw: _pw, point, ...resolved } = r;
      return { frame: frameRef, point, handle, resolved };
    }
    const frame = findFrame(this.page, target.frame) ?? this.page.mainFrame();
    return { frame, point: target.point, handle: await this.handleAtPoint(frame, target.point) };
  }

  async resolve(locator: Locator): Promise<Resolved | null> {
    const r = await resolveLocator(this.page, locator);
    if (!r) return null;
    const { frameRef: _f, pw: _pw, point: _p, ...resolved } = r;
    return resolved;
  }

  async captureLocator(elementIndex: number): Promise<Locator> {
    const s = this.elementAt(elementIndex);
    const frame = findFrame(this.page, s.frame);
    if (!frame) throw new Error(`frame ${s.frame.join("/")} not found`);
    const handle = await this.handleAtPoint(frame, { x: s.bbox[0] + s.bbox[2] / 2, y: s.bbox[1] + s.bbox[3] / 2 });
    if (!handle) throw new Error(`no element under #${elementIndex}`);
    try {
      return await captureLocatorFor(frame, handle, s, this.viewport);
    } finally {
      await handle.dispose();
    }
  }

  // ---- acting ----

  /**
   * Resolves as soon as a modal dialog appears. A native alert freezes the page, so any Playwright
   * action already in flight never settles — the caller waits for a click that can no longer happen.
   * Racing against this turns an indefinite hang into "the dialog is why", which the executor can
   * classify and escalate. Legacy applications raise these on interaction, not only on load, so the
   * case is not exotic.
   */
  private dialogAppeared(): Promise<"dialog"> {
    return new Promise((resolve) => {
      if (this.dialog) return resolve("dialog");
      const iv = setInterval(() => {
        if (this.dialog) {
          clearInterval(iv);
          resolve("dialog");
        }
      }, 50);
      iv.unref?.();
    });
  }

  async act(action: SurfaceAction): Promise<ActResult> {
    const started = Date.now();
    const done = (partial: Omit<ActResult, "durationMs">): ActResult => ({ ...partial, durationMs: Date.now() - started });
    try {
      if (this.dialog && action.kind !== "dismissDialog") return done({ ok: false, error: `dialog open: ${this.dialog.info.type} "${this.dialog.info.message}"` });
      if (action.kind !== "dismissDialog") {
        const outcome = await Promise.race([this.perform(action, done), this.dialogAppeared()]);
        if (outcome !== "dialog") return outcome;
        return done({ ok: false, error: `dialog open: ${this.dialog!.info.type} "${this.dialog!.info.message}"` });
      }
      return await this.perform(action, done);
    } catch (e) {
      return done({ ok: false, error: (e as Error).message });
    }
  }

  private async perform(action: SurfaceAction, done: (partial: Omit<ActResult, "durationMs">) => ActResult): Promise<ActResult> {
    try {
      switch (action.kind) {
        case "navigate": {
          await this.open(action.url);
          return done({ ok: true });
        }
        case "dismissDialog": {
          if (!this.dialog) return done({ ok: false, error: "no dialog open" });
          const d = this.dialog.handle;
          this.dialog = undefined;
          if (action.accept) await d.accept(action.text);
          else await d.dismiss();
          await this.settle();
          return done({ ok: true });
        }
        case "press": {
          await this.page.keyboard.press(action.key);
          await this.settle();
          return done({ ok: true });
        }
        case "scroll": {
          const at = action.target ? (await this.resolveTarget(action.target)).point : { x: this.viewport.width / 2, y: this.viewport.height / 2 };
          await this.page.mouse.move(at.x, at.y);
          await this.page.mouse.wheel(action.dx, action.dy);
          await this.settle();
          return done({ ok: true });
        }
        case "click": {
          const t = await this.resolveTarget(action.target);
          if (t.handle) await t.handle.scrollIntoViewIfNeeded().catch(() => {});
          await this.page.mouse.click(t.point.x, t.point.y);
          await this.settle();
          return done({ ok: true, ...(t.resolved ? { resolved: t.resolved } : {}) });
        }
        case "type": {
          const t = await this.resolveTarget(action.target);
          if (!t.handle) return done({ ok: false, error: "no element at target", ...(t.resolved ? { resolved: t.resolved } : {}) });
          let ok = false;
          try {
            await t.handle.fill(action.text, { timeout: 3000 });
            ok = (await t.handle.inputValue().catch(() => "")) === action.text;
          } catch {
            ok = false;
          }
          if (!ok) {
            await this.page.mouse.click(t.point.x, t.point.y);
            await this.page.keyboard.press("ControlOrMeta+A");
            await this.page.keyboard.type(action.text);
            ok = (await t.handle.inputValue().catch(() => action.text)) === action.text;
          }
          await this.settle();
          return done({ ok, ...(ok ? {} : { error: "typed value did not stick" }), ...(t.resolved ? { resolved: t.resolved } : {}) });
        }
        case "select": {
          const t = await this.resolveTarget(action.target);
          if (!t.handle) return done({ ok: false, error: "no element at target" });
          const chosen = await t.handle.selectOption({ label: action.value }).catch(async () => t.handle!.selectOption(action.value));
          await this.settle();
          return done({ ok: chosen.length > 0, ...(t.resolved ? { resolved: t.resolved } : {}) });
        }
      }
    } catch (e) {
      return done({ ok: false, error: (e as Error).message });
    }
  }

  // ---- reading ----

  async readText(locator: Locator): Promise<TextReadResult | null> {
    const r = await resolveLocator(this.page, locator);
    if (!r) return null;
    const text = r.pw ? await r.pw.innerText().catch(() => "") : "";
    return { text: text.replace(/\s+/g, " ").trim(), bbox: r.bbox };
  }

  async extract(candidate: ExtractionCandidate, defaultFrame?: string[]): Promise<string | null> {
    if (this.dialog) return null;
    return extractByCandidate(this.page, candidate, defaultFrame);
  }

  async visibleText(frame?: string[]): Promise<string> {
    if (this.dialog) return "";
    const frames = frame ? [findFrame(this.page, frame)].filter((f): f is Frame => Boolean(f)) : allFrames(this.page);
    const parts: string[] = [];
    for (const f of frames) parts.push(await f.evaluate(() => (document.body ?? document.documentElement).innerText ?? "").catch(() => ""));
    return parts.join("\n").replace(/[ \t]+/g, " ").trim();
  }

  async landmarkVisible(role: string, name: string, frame?: string[], exact = false): Promise<boolean> {
    if (this.dialog) return false;
    const frames = frame ? [findFrame(this.page, frame)].filter((f): f is Frame => Boolean(f)) : allFrames(this.page);
    for (const f of frames) {
      // "text" landmarks come from StaticText nodes (headers, captions) and are matched by visible text
      const loc = role === "text" ? f.getByText(name, { exact }) : f.getByRole(role as Parameters<Frame["getByRole"]>[0], { name, exact });
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 10); i += 1) if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.opts.tracePath && this.context) await this.context.tracing.stop({ path: this.opts.tracePath }).catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

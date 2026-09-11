/**
 * A Surface that only acts while its lease is the current one.
 *
 * The alternative was threading a lease token through `Surface.act` and every caller of it. That
 * would have put session control into the surface contract, which is supposed to describe only how
 * an application is perceived and driven — a desktop surface has no idea what an intervention is.
 * Wrapping instead keeps the contract clean, keeps `executor.ts` and `loop.ts` untouched, and makes
 * the rule impossible to forget: whoever holds a leased surface can act, and revoking the lease
 * disarms every reference to it at once, including one captured mid-await.
 *
 * Reads pass straight through. Observing a page nobody controls is harmless, and the console needs
 * to keep rendering frames while the engine is paused.
 */
import type { ExtractionCandidate, Locator } from "@cua/schema";
import type { ActResult, DialogInfo, Observation, Resolved, Surface, SurfaceAction, TextReadResult } from "../surface/types.js";
import { ControlViolation, type Controller } from "./types.js";

export interface LeaseAuthority {
  /** The lease id that is currently allowed to act, or undefined when nobody may. */
  currentLeaseId(): string | undefined;
  currentController(): Controller;
  /** Reports an attempted act by a stale lease, for the evidence log. */
  onViolation?(by: Controller, what: string): void;
}

export class LeasedSurface implements Surface {
  readonly kind: "web" | "desktop";

  constructor(
    private readonly inner: Surface,
    private readonly leaseId: string,
    private readonly controller: Controller,
    private readonly authority: LeaseAuthority,
  ) {
    this.kind = inner.kind;
  }

  private guard(what: string): void {
    if (this.authority.currentLeaseId() === this.leaseId) return;
    this.authority.onViolation?.(this.controller, what);
    throw new ControlViolation(this.controller, this.authority.currentController(), what);
  }

  /** True when this surface may still act. Callers that prefer a result to an exception can ask. */
  get valid(): boolean {
    return this.authority.currentLeaseId() === this.leaseId;
  }

  // ---- mutating: lease required ----
  async open(url: string): Promise<void> {
    this.guard("open");
    return this.inner.open(url);
  }
  async act(action: SurfaceAction): Promise<ActResult> {
    this.guard(`act:${action.kind}`);
    return this.inner.act(action);
  }
  async setCookie(url: string, name: string, value: string): Promise<void> {
    this.guard("setCookie");
    return this.inner.setCookie(url, name, value);
  }
  async reload(frame?: string[]): Promise<void> {
    this.guard("reload");
    return this.inner.reload(frame);
  }

  // ---- read-only: always allowed ----
  observe(): Promise<Observation> {
    return this.inner.observe();
  }
  resolve(locator: Locator): Promise<Resolved | null> {
    return this.inner.resolve(locator);
  }
  captureLocator(elementIndex: number): Promise<Locator> {
    return this.inner.captureLocator(elementIndex);
  }
  readText(locator: Locator): Promise<TextReadResult | null> {
    return this.inner.readText(locator);
  }
  readValue(locator: Locator): Promise<string | null> {
    return this.inner.readValue(locator);
  }
  extract(candidate: ExtractionCandidate, defaultFrame?: string[]): Promise<string | null> {
    return this.inner.extract(candidate, defaultFrame);
  }
  visibleText(frame?: string[]): Promise<string> {
    return this.inner.visibleText(frame);
  }
  landmarkVisible(role: string, name: string, frame?: string[], exact?: boolean): Promise<boolean> {
    return this.inner.landmarkVisible(role, name, frame, exact);
  }
  frameUrl(frame?: string[]): string | undefined {
    return this.inner.frameUrl(frame);
  }
  pendingDialog(): DialogInfo | undefined {
    return this.inner.pendingDialog();
  }
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer> {
    return this.inner.screenshot(opts);
  }
  onPageSwitch(handler: (url: string) => "adopt" | "close"): void {
    this.inner.onPageSwitch(handler);
  }

  /**
   * Closing is the browser's lifecycle, not the run's, so it belongs to whoever owns the surface.
   * A leased view never closes the window out from under the other controller.
   */
  async close(): Promise<void> {
    /* no-op: the session owns the underlying surface */
  }
}

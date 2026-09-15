/**
 * The surface boundary gate (enforcement layer 2 of 4).
 *
 * Written as a wrapper rather than as checks inside `PlaywrightSurface`, for the same reason
 * `LeasedSurface` is a wrapper: the Surface contract describes how an application is perceived and
 * driven, and a desktop surface has no opinion about allowlists. Wrapping also means the rule
 * cannot be forgotten by a new surface implementation, and that replay — which never consults the
 * decision-time gate, because there is no model in the loop — passes the same check as discovery.
 *
 * Compose it innermost, under the lease:
 *
 *     new Session({ surface: new PolicyEnforcedSurface(playwright, { gate }) })
 *
 * so that every lease the session hands out, to the engine or to a human, resolves through it.
 *
 * A human is not blocked. An operator who has taken control has authority the engine does not, and
 * a gate that stopped them would make escalation useless precisely when it is needed — the reason
 * to take control is usually that the screen is somewhere the engine could not go. Their action is
 * recorded as `policy_override` instead, which is the auditable outcome rather than the silent one.
 */
import type { ExtractionCandidate, Locator } from "@cua/schema";
import type { ActResult, DialogInfo, Observation, Resolved, Surface, SurfaceAction, TextReadResult } from "../surface/types.js";
import type { DiscoveryPolicy } from "./basic.js";

export interface PolicyEnforcementOptions {
  gate: DiscoveryPolicy;
  /**
   * Who is acting right now. Defaults to the engine. The session supplies this so that a human's
   * out-of-allowlist navigation is logged and allowed rather than thrown.
   */
  controller?: () => string;
  /** Called when the engine is stopped. */
  onBlock?: (what: string, reason: string) => void;
  /** Called when a human proceeds past a check the engine would have failed. */
  onOverride?: (controller: string, what: string, reason: string) => void;
}

export class PolicyViolation extends Error {
  readonly code = "POLICY_VIOLATION";
  constructor(
    readonly what: string,
    readonly detail: string,
  ) {
    super(`policy refused ${what}: ${detail}`);
    this.name = "PolicyViolation";
  }
}

export class PolicyEnforcedSurface implements Surface {
  readonly kind: "web" | "desktop";

  constructor(
    private readonly inner: Surface,
    private readonly opts: PolicyEnforcementOptions,
  ) {
    this.kind = inner.kind;
  }

  /** Returns true when the caller may proceed; throws for the engine, logs an override for a human. */
  private guard(what: string, url: string | undefined): void {
    if (url === undefined) return;
    if (this.opts.gate.allowRequest(url)) return;
    const reason = `${url} is outside the allowlist (${this.opts.gate.allowedOrigins.join(", ")})`;
    const by = this.opts.controller?.() ?? "agent";
    if (by === "human") {
      this.opts.onOverride?.(by, what, reason);
      return;
    }
    this.opts.onBlock?.(what, reason);
    throw new PolicyViolation(what, reason);
  }

  // ---- mutating: checked ----
  async open(url: string): Promise<void> {
    this.guard("open", url);
    return this.inner.open(url);
  }

  async act(action: SurfaceAction): Promise<ActResult> {
    // Only `navigate` names a destination up front. A click that happens to navigate somewhere
    // disallowed is caught by layer 3 (request interception) and by the page-switch handler, which
    // is the right division of labour: this layer knows intent, that one knows what actually left.
    if (action.kind === "navigate") this.guard("act:navigate", action.url);
    return this.inner.act(action);
  }

  async setCookie(url: string, name: string, value: string): Promise<void> {
    this.guard("setCookie", url);
    return this.inner.setCookie(url, name, value);
  }

  async reload(frame?: string[]): Promise<void> {
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
  close(): Promise<void> {
    return this.inner.close();
  }
}

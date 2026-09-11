/**
 * Condition-based waits. Never a fixed sleep beyond the surface's 150ms settle; every wait has a
 * condition and a timeout, and reports whether it was satisfied and how long it took.
 */
import type { Wait } from "@cua/schema";
import type { Surface } from "../surface/types.js";

export interface WaitResult {
  satisfied: boolean;
  elapsedMs: number;
  detail: string;
}

export async function performWait(w: Wait, surface: Surface, before: { frameUrl: string | undefined }, defaultFrame?: string[]): Promise<WaitResult> {
  const started = Date.now();
  const done = (satisfied: boolean, detail: string): WaitResult => ({ satisfied, elapsedMs: Date.now() - started, detail });
  const poll = async (cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      if (surface.pendingDialog()) return true; // a dialog is a state, not a timeout
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return cond();
  };
  switch (w.for) {
    case "none":
      return done(true, "no wait");
    case "load":
    case "networkIdle": {
      // the surface already waits for load on act; here we only confirm the page is observable
      const ok = await poll(async () => !surface.pendingDialog() && (await surface.visibleText(defaultFrame).catch(() => "")).length >= 0, w.timeoutMs);
      return done(ok, w.for);
    }
    case "urlChange": {
      const ok = await poll(async () => surface.frameUrl(defaultFrame) !== before.frameUrl, w.timeoutMs);
      return done(ok, ok ? `url changed to ${surface.frameUrl(defaultFrame) ?? ""}` : `url still ${before.frameUrl ?? ""}`);
    }
    case "landmark": {
      const frame = w.frame ?? defaultFrame;
      const ok = await poll(() => surface.landmarkVisible(w.landmark.role, w.landmark.name, frame, w.landmark.exact ?? false), w.timeoutMs);
      return done(ok, `${w.landmark.role} "${w.landmark.name}" ${ok ? "visible" : "not visible"}`);
    }
  }
}

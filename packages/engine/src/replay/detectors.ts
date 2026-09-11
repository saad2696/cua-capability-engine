/**
 * Detector pipeline: after every step, classify the screen against the artifact's outcome
 * catalog. Order matters and is fixed: dialogs first (they block everything), then URL-based,
 * then text-based, then HTTP status, then landmarks. First matching outcome wins.
 */
import type { Detector, Outcome } from "@cua/schema";
import type { Observation, Surface } from "../surface/types.js";
import { textMatches, toRegExp } from "./text.js";

export interface ScreenState {
  observation: Observation;
  /** Visible text per content frame, joined. */
  text: string;
  frameUrls: Record<string, string>;
}

export async function captureScreenState(surface: Surface): Promise<ScreenState> {
  const observation = await surface.observe();
  const contentFrames = observation.frames.filter((f) => f.path.length);
  const frameUrls: Record<string, string> = {};
  for (const f of observation.frames) frameUrls[f.path.join("/")] = f.url;
  const parts: string[] = [];
  if (observation.dialog) {
    // page scripts cannot run while a dialog blocks; use the last known text if any
    parts.push("");
  } else {
    for (const f of contentFrames.length ? contentFrames : [{ path: [] as string[] }]) parts.push(await surface.visibleText(f.path.length ? f.path : undefined).catch(() => ""));
  }
  return { observation, text: parts.join("\n"), frameUrls };
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

export function detectorMatches(d: Detector, state: ScreenState): boolean {
  switch (d.kind) {
    case "dialogOpen": {
      const dlg = state.observation.dialog;
      if (!dlg) return false;
      if (d.dialogType && dlg.type !== d.dialogType) return false;
      if (d.messageMatches && !toRegExp(d.messageMatches).test(dlg.message)) return false;
      return true;
    }
    case "urlMatches": {
      const urls = d.scope === "top" ? [state.observation.url] : Object.entries(state.frameUrls).filter(([k]) => k !== "").map(([, v]) => v);
      const candidates = urls.length ? urls : [state.observation.url];
      return candidates.some((u) => toRegExp(d.pattern, d.flags ?? "").test(pathOf(u)) || toRegExp(d.pattern, d.flags ?? "").test(u));
    }
    case "textMatches":
      return textMatches(state.text, d.pattern, d.flags);
    case "httpStatus": {
      const s = state.observation.lastHttpStatus;
      return s !== undefined && s >= d.min && s <= d.max;
    }
    case "landmarkVisible":
      return state.observation.landmarks.some((l) => l.role === d.landmark.role && (d.landmark.exact ? l.name === d.landmark.name : l.name.toLowerCase().includes(d.landmark.name.toLowerCase())) && (!d.frame || l.frame.join("/") === d.frame.join("/")));
  }
}

const ORDER: Record<Detector["kind"], number> = { dialogOpen: 0, urlMatches: 1, textMatches: 2, httpStatus: 3, landmarkVisible: 4 };

/** Outcomes whose detectors all match, most specific class first (dialog > url > text > http > landmark), then declaration order. */
export function matchOutcomes(outcomes: Outcome[], state: ScreenState, stepId?: string): Outcome[] {
  const applicable = outcomes.filter((o) => o.appliesTo === "any" || (stepId !== undefined && o.appliesTo.includes(stepId)));
  const matched = applicable.filter((o) => o.detect.every((d) => detectorMatches(d, state)));
  const rank = (o: Outcome) => Math.min(...o.detect.map((d) => ORDER[d.kind]));
  return matched.sort((a, b) => rank(a) - rank(b) || (a.detect.some((d) => d.kind === "dialogOpen" && d.messageMatches) ? -1 : 0));
}

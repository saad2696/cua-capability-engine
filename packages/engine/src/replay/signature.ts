/**
 * Screen signatures: are we on the screen this step was recorded on? Checked BEFORE acting.
 */
import type { ScreenSignature } from "@cua/schema";
import type { Surface } from "../surface/types.js";
import { checkAssertion } from "./assertions.js";
import { toRegExp } from "./text.js";
import type { ValueContext } from "./values.js";

export interface SignatureVerdict {
  ok: boolean;
  urlOk: boolean;
  landmarksFound: string[];
  landmarksMissing: string[];
  negativesHit: string[];
  required: number;
}

export async function checkSignature(sig: ScreenSignature, surface: Surface, ctx: ValueContext): Promise<SignatureVerdict> {
  const frame = sig.frames.length ? sig.frames : undefined;
  let urlOk = true;
  if (sig.urlPattern) {
    const url = surface.frameUrl(frame) ?? "";
    let path = url;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      /* keep raw */
    }
    urlOk = toRegExp(sig.urlPattern, "").test(path) || toRegExp(sig.urlPattern, "").test(url);
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const l of sig.landmarks) {
    const label = `${l.role} "${l.name}"`;
    if (await surface.landmarkVisible(l.role, l.name, frame, l.exact ?? false)) found.push(label);
    else missing.push(label);
  }
  const negativesHit: string[] = [];
  for (const n of sig.negative) {
    const v = await checkAssertion(n, surface, ctx, undefined, frame);
    if (!v.ok) negativesHit.push(`${v.expected} — ${v.observed}`);
  }
  const required = Math.min(sig.minLandmarks ?? 2, sig.landmarks.length);
  return { ok: urlOk && found.length >= required && negativesHit.length === 0, urlOk, landmarksFound: found, landmarksMissing: missing, negativesHit, required };
}

export function describeSignature(sig: ScreenSignature): string {
  return `${sig.urlPattern ? `url ${sig.urlPattern}; ` : ""}${Math.min(sig.minLandmarks ?? 2, sig.landmarks.length)} of [${sig.landmarks.map((l) => `${l.role} "${l.name}"`).join(", ")}]`;
}

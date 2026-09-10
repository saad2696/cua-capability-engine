/**
 * Locator resolution: try candidates in order, require exactly one visible match (or
 * disambiguate by proximity to the recorded box), report which strategy matched.
 */
import type { Frame, Locator as PwLocator, Page } from "playwright";
import type { BBox, Locator, LocatorCandidate } from "@cua/schema";
import { findFrame } from "./frames.js";
import type { Resolved } from "../types.js";

export interface ResolvedHandle extends Resolved {
  frameRef: Frame;
  /** Playwright locator narrowed to exactly one element, or undefined for visual (point) matches. */
  pw?: PwLocator;
  point: { x: number; y: number };
}

const cssEscape = (s: string) => s.replace(/(["\\])/g, "\\$1");
const xpathLit = (s: string) => (s.includes('"') ? `concat("${s.split('"').join('", \'"\', "')}")` : `"${s}"`);

/** Build the Playwright locator for a candidate inside a frame. */
export function candidateToPw(frame: Frame, c: LocatorCandidate): PwLocator | null {
  switch (c.strategy) {
    case "role":
      return frame.getByRole(c.role as Parameters<Frame["getByRole"]>[0], { name: c.name, exact: c.exact });
    case "label": {
      // <label for>/aria-labelledby first; then the legacy pattern: label cell followed by a control cell.
      const byLabel = frame.getByLabel(c.text, { exact: c.exact });
      const cellText = c.exact ? `normalize-space(.)=${xpathLit(c.text)}` : `contains(normalize-space(.), ${xpathLit(c.text)})`;
      const legacy = frame.locator(`xpath=//td[${cellText}]/following-sibling::td[1]//*[self::input or self::select or self::textarea]`);
      const titled = frame.locator(`[title="${cssEscape(c.text)}"]`);
      return byLabel.or(legacy).or(titled);
    }
    case "text": {
      const byText = frame.getByText(c.text, { exact: c.exact });
      const inputs = frame.locator(`input[type="submit"][value="${cssEscape(c.text)}"], input[type="button"][value="${cssEscape(c.text)}"], button:has-text("${cssEscape(c.text)}")`);
      return byText.or(inputs);
    }
    case "placeholder":
      return frame.getByPlaceholder(c.text);
    case "css":
      return frame.locator(c.selector);
    case "visual":
      return null;
  }
}

/** Playwright bounding boxes are already relative to the main-frame viewport, i.e. page coordinates. */
async function visibleBoxes(pw: PwLocator): Promise<BBox[]> {
  const boxes: BBox[] = [];
  const n = Math.min(await pw.count(), 25);
  for (let i = 0; i < n; i += 1) {
    const el = pw.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const b = await el.boundingBox().catch(() => null);
    if (b && b.width > 0 && b.height > 0) boxes.push([Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]);
    else boxes.push([-1, -1, 0, 0]);
  }
  return boxes;
}

const center = (b: BBox) => ({ x: b[0] + b[2] / 2, y: b[1] + b[3] / 2 });
const dist = (a: BBox, b: BBox) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y);

export async function resolveLocator(page: Page, locator: Locator): Promise<ResolvedHandle | null> {
  const frame = findFrame(page, locator.frame);
  if (!frame) return null;
  let attempts = 0;
  for (let i = 0; i < locator.candidates.length; i += 1) {
    const c = locator.candidates[i]!;
    attempts += 1;
    if (c.strategy === "visual") {
      // trust the recorded box only if the anchor text is still nearby (or no anchor was recorded)
      const [x, y, w, h] = c.bbox;
      if (c.anchorText) {
        const anchors = await visibleBoxes(frame.getByText(c.anchorText));
        if (!anchors.some((a) => dist(a, c.bbox) <= 150)) continue;
      }
      return { strategy: "visual", candidateIndex: i, attempts, bbox: c.bbox, frame: locator.frame, frameRef: frame, point: { x: x + w / 2, y: y + h / 2 } };
    }
    const pw = candidateToPw(frame, c);
    if (!pw) continue;
    const boxes = await visibleBoxes(pw);
    const visibleIdx = boxes.map((b, idx) => (b[2] > 0 ? idx : -1)).filter((idx) => idx >= 0);
    if (visibleIdx.length === 0) continue;
    let pick = visibleIdx[0]!;
    if (visibleIdx.length > 1) {
      if (!locator.recordedBBox) continue; // ambiguous and no way to disambiguate: try the next strategy
      pick = visibleIdx.reduce((best, idx) => (dist(boxes[idx]!, locator.recordedBBox!) < dist(boxes[best]!, locator.recordedBBox!) ? idx : best), visibleIdx[0]!);
      if (dist(boxes[pick]!, locator.recordedBBox) > 200) continue; // nearest match is too far from where it was
    }
    const bbox = boxes[pick]!;
    const target = pw.nth(pick);
    const role = (await target.evaluate((el) => (el as HTMLElement).getAttribute("role") ?? (el as HTMLElement).tagName.toLowerCase()).catch(() => undefined)) as string | undefined;
    return { strategy: c.strategy, candidateIndex: i, attempts, bbox, frame: locator.frame, frameRef: frame, pw: target, point: center(bbox), ...(role ? { role } : {}) };
  }
  return null;
}

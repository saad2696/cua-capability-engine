/**
 * Set-of-Marks overlay: draw a numbered tag next to each interactive element so the model can
 * refer to controls by number. Marks are injected into each frame's document (frameset top
 * documents have no body to draw on), screenshotted, then removed.
 */
import type { Page } from "playwright";
import type { ElementSummary } from "@cua/schema";
import { findFrame, frameOffset } from "./frames.js";

const MARK_ATTR = "data-cua-mark";

export async function withMarks<T>(page: Page, elements: ElementSummary[], fn: () => Promise<T>): Promise<T> {
  const byFrame = new Map<string, ElementSummary[]>();
  for (const e of elements) {
    const key = e.frame.join("/");
    byFrame.set(key, [...(byFrame.get(key) ?? []), e]);
  }
  const injected: string[] = [];
  for (const [key, els] of byFrame) {
    const frame = findFrame(page, key ? key.split("/") : []);
    if (!frame) continue;
    const off = await frameOffset(frame);
    const marks = els.map((e) => ({ index: e.index, x: e.bbox[0] - off.x, y: e.bbox[1] - off.y, w: e.bbox[2], h: e.bbox[3] }));
    try {
      await frame.evaluate(
        ({ marks, attr }) => {
          const root = document.body ?? document.documentElement;
          for (const m of marks) {
            const box = document.createElement("div");
            box.setAttribute(attr, "box");
            box.style.cssText = `position:absolute;left:${m.x + window.scrollX}px;top:${m.y + window.scrollY}px;width:${m.w}px;height:${m.h}px;border:2px solid #e11d48;box-sizing:border-box;pointer-events:none;z-index:2147483646;`;
            const tag = document.createElement("div");
            tag.setAttribute(attr, "tag");
            tag.textContent = String(m.index);
            tag.style.cssText = `position:absolute;left:${Math.max(0, m.x - 2) + window.scrollX}px;top:${Math.max(0, m.y - 14) + window.scrollY}px;background:#e11d48;color:#fff;font:bold 11px/14px Arial,sans-serif;padding:0 4px;border-radius:3px;pointer-events:none;z-index:2147483647;`;
            root.appendChild(box);
            root.appendChild(tag);
          }
        },
        { marks, attr: MARK_ATTR },
      );
      injected.push(key);
    } catch {
      // frame navigated; skip marks for it
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of injected) {
      const frame = findFrame(page, key ? key.split("/") : []);
      await frame?.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((n) => n.remove()), MARK_ATTR).catch(() => {});
    }
  }
}

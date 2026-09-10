/**
 * Deterministic re-reading of a value from the screen, by extraction candidate. Used by the
 * recorder to verify that a value the model read can be found again, and by replay to read it.
 */
import type { Frame, Page } from "playwright";
import type { ExtractionCandidate } from "@cua/schema";
import { allFrames, findFrame } from "./frames.js";
import { resolveLocator } from "./resolver.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

async function tableCell(frame: Frame, rowMatch: string, columnHeader: string): Promise<string | null> {
  return frame.evaluate(
    ({ rowMatch, columnHeader }) => {
      const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      for (const table of Array.from(document.querySelectorAll("table"))) {
        const rows = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr"));
        // header row: the first row whose cells include the column header text
        let col = -1;
        for (const r of rows) {
          const cells = Array.from(r.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
          const idx = cells.findIndex((c) => norm(c.textContent).toLowerCase() === columnHeader.toLowerCase());
          if (idx >= 0) {
            col = idx;
            break;
          }
        }
        if (col < 0) continue;
        for (const r of rows) {
          const cells = Array.from(r.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
          if (cells.some((c) => norm(c.textContent).toLowerCase() === rowMatch.toLowerCase()) && cells[col]) {
            const v = norm(cells[col]!.textContent);
            if (v.toLowerCase() !== columnHeader.toLowerCase()) return v;
          }
        }
      }
      return null;
    },
    { rowMatch, columnHeader },
  );
}

async function cellRightOfLabel(frame: Frame, label: string): Promise<string | null> {
  return frame.evaluate((label) => {
    const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    for (const td of Array.from(document.querySelectorAll("td, th"))) {
      if (norm(td.textContent).toLowerCase() !== label.toLowerCase()) continue;
      const next = td.nextElementSibling;
      if (next && (next.tagName === "TD" || next.tagName === "TH")) {
        const input = next.querySelector("input, select, textarea") as HTMLInputElement | HTMLSelectElement | null;
        if (input) return input.tagName === "SELECT" ? ((input as HTMLSelectElement).selectedOptions[0]?.textContent ?? "") : (input as HTMLInputElement).value;
        return norm(next.textContent);
      }
    }
    return null;
  }, label);
}

export async function extractByCandidate(page: Page, c: ExtractionCandidate, defaultFrame?: string[]): Promise<string | null> {
  const framePath = "frame" in c && c.frame ? c.frame : c.strategy === "locator" ? c.locator.frame : defaultFrame;
  const frames = framePath ? [findFrame(page, framePath)].filter((f): f is Frame => Boolean(f)) : allFrames(page);
  for (const frame of frames) {
    try {
      switch (c.strategy) {
        case "tableCell": {
          const v = await tableCell(frame, c.rowMatch, c.columnHeader);
          if (v !== null) return v;
          break;
        }
        case "cellRightOfLabel": {
          const v = await cellRightOfLabel(frame, c.label);
          if (v !== null) return v;
          break;
        }
        case "regexInRegion": {
          const text = norm(await frame.evaluate(() => (document.body ?? document.documentElement).innerText ?? ""));
          const m = new RegExp(c.pattern, "i").exec(text);
          if (m) return norm(m[c.group] ?? m[0]);
          break;
        }
        case "locator": {
          const r = await resolveLocator(page, c.locator);
          if (r?.pw) return norm(await r.pw.innerText());
          break;
        }
      }
    } catch {
      // frame navigated or evaluation failed; try the next frame
    }
  }
  return null;
}

/**
 * cua observe <url> [--out <dir>] [--headed]
 * Opens the URL, perceives it the way the agent will (accessibility tree + marked screenshot),
 * and writes the evidence bundle. Handy for debugging perception on a new app.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PlaywrightSurface } from "@cua/engine";

export async function observeCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: "string" }, headed: { type: "boolean", default: false } } });
  const url = positionals[0];
  if (!url) {
    console.error("usage: cua observe <url> [--out <dir>] [--headed]");
    process.exitCode = 1;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = values.out ?? join(process.env["CUA_EVIDENCE_DIR"] ?? "evidence", `observe-${stamp}`);
  mkdirSync(out, { recursive: true });
  const surface = new PlaywrightSurface({ headless: !values.headed });
  try {
    await surface.open(url);
    const obs = await surface.observe();
    writeFileSync(join(out, "screenshot-marked.png"), obs.screenshotPng);
    writeFileSync(join(out, "screenshot.png"), obs.rawScreenshotPng);
    const { screenshotPng: _a, rawScreenshotPng: _b, ...rest } = obs;
    writeFileSync(join(out, "observation.json"), JSON.stringify(rest, null, 2));
    console.log(`observed ${obs.url} — ${obs.elements.length} interactive elements in ${obs.frames.length} frame(s)`);
    for (const e of obs.elements) console.log(`  [${e.index}] ${e.role.padEnd(9)} ${JSON.stringify(e.name).padEnd(24)} frame=${e.frame.join("/") || "(top)"} bbox=${e.bbox.join(",")}${e.value !== undefined ? ` value=${JSON.stringify(e.value)}` : ""}`);
    if (obs.dialog) console.log(`  dialog: ${obs.dialog.type} "${obs.dialog.message}"`);
    console.log(`evidence written to ${out}`);
  } finally {
    await surface.close();
  }
}

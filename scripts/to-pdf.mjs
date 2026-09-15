#!/usr/bin/env node
/**
 * Render a local HTML document to PDF, with the mermaid diagrams drawn.
 *
 * Chrome's own "Save as PDF" prints the page before the diagrams have rendered — mermaid is loaded
 * as an ES module from a CDN and draws asynchronously, so the print job can start against a
 * document whose figures are still empty. This waits for the SVGs to exist, then prints.
 *
 * Uses the Playwright that the engine already depends on, so there is nothing new to install.
 *
 *   node scripts/to-pdf.mjs docs/demo-narration.html [docs/demo-narration.pdf]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
// pnpm isolates dependencies per package, so playwright lives under the engine rather than at the
// workspace root. Resolve it from there instead of adding a root dependency for one script.
const { chromium } = await import(new URL("../packages/engine/node_modules/playwright/index.mjs", import.meta.url).href);

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/to-pdf.mjs <file.html> [out.pdf]");
  process.exit(1);
}
const htmlPath = resolve(input);
const out = resolve(process.argv[3] ?? htmlPath.replace(/\.html$/, ".pdf"));
const root = dirname(htmlPath);

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mmd": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

// Served over HTTP rather than opened as file:// — a module script from a CDN is blocked on a
// file:// origin, which would leave the diagrams unrendered and the page looking broken.
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const path = rel === "/" ? htmlPath : resolve(root, `.${rel}`);
  if (!path.startsWith(root)) return void res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });

  const figures = await page.locator(".mermaid").count();
  if (figures) {
    const drawn = await page
      .waitForFunction((n) => document.querySelectorAll(".mermaid svg").length >= n, figures, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    // Worth saying out loud rather than shipping a PDF with holes in it.
    console.warn(drawn ? `  ${figures} diagram(s) rendered` : `  WARNING: diagrams did not render (offline?); the PDF will have gaps`);
  }

  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: out,
    format: "A4",
    printBackground: true,
    margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
  });
  console.log(`  ${basename(out)} written`);
} finally {
  await browser.close();
  server.close();
}

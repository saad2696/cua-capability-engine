import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("cua cli", () => {
  it("prints version", () => {
    const out = execFileSync("pnpm", ["exec", "tsx", resolve(here, "main.ts"), "version"], {
      cwd: resolve(here, ".."),
      encoding: "utf8",
    });
    expect(out).toContain("cua-capability-engine schema=1.0");
  });
});

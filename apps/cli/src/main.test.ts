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

describe("cua artifact", () => {
  const run = (...args: string[]) =>
    execFileSync("pnpm", ["exec", "tsx", resolve(here, "main.ts"), ...args], { cwd: resolve(here, ".."), encoding: "utf8" });
  const example = resolve(here, "../../../artifacts/examples/member-savings-balance@1.json");
  it("validates the example", () => {
    expect(run("artifact", "validate", example)).toContain("OK");
  });
  it("prints a review summary", () => {
    const out = run("artifact", "summary", example);
    expect(out).toContain("Inputs:");
    expect(out).toContain("memberId: string  (pii)");
    expect(out).toContain("MEMBER_NOT_FOUND");
    expect(out).not.toContain("hunter");
  });
});

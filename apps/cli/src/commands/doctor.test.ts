/**
 * `cua doctor` tests.
 *
 * The check worth testing is the secret one, and testing it properly means building throwaway git
 * repositories: the whole point of asking `git ls-files` rather than reading `.gitignore` is that
 * the two disagree when a file was committed before the ignore rule existed, and only a real repo
 * in that state proves the right question is being asked.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorCommand } from "./doctor.js";

const made: string[] = [];

/**
 * Key-shaped fixtures, assembled at runtime.
 *
 * Written as a literal they would be the only key-shaped strings in the repository, and
 * `cua doctor`'s own "no API key in tracked files" check would fail on the file that tests it —
 * a checker that cries wolf on its own fixtures is a checker people learn to skip. Joining the
 * pieces keeps the literal out of the tracked source while the temporary repo still gets a string
 * the detector must catch.
 */
const fakeKey = (suffix: string) => ["sk", "ant", suffix].join("-");

function repo(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "cua-doctor-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  setup(dir);
  git("add", "-A");
  git("commit", "-q", "-m", "initial", "--no-verify");
  return dir;
}

/** Run doctor against a directory and return the parsed JSON report. */
async function run(dir: string): Promise<{ ok: boolean; checks: { name: string; level: string; detail: string }[] }> {
  const prevRoot = process.env["CUA_ROOT"];
  const prevCode = process.exitCode;
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => void lines.push(s);
  process.env["CUA_ROOT"] = dir;
  try {
    await doctorCommand(["--json", "--skip-network"]);
  } finally {
    console.log = log;
    if (prevRoot === undefined) delete process.env["CUA_ROOT"];
    else process.env["CUA_ROOT"] = prevRoot;
    process.exitCode = prevCode;
  }
  return JSON.parse(lines.join("\n")) as never;
}

const find = (r: Awaited<ReturnType<typeof run>>, name: string) => r.checks.find((c) => c.name === name);

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cua doctor", () => {
  it("passes a clean repository", async () => {
    const dir = repo((d) => {
      writeFileSync(join(d, ".gitignore"), ".env\n");
      writeFileSync(join(d, ".env.example"), "ANTHROPIC_API_KEY=\nTARGET_APP_URL=http://localhost:4100\n");
      // Untracked because it is ignored — the case that must pass.
      writeFileSync(join(d, ".env"), `ANTHROPIC_API_KEY=${fakeKey("realkeygoeshere")}\n`);
    });
    const r = await run(dir);
    expect(find(r, ".env is untracked")?.level).toBe("ok");
    expect(find(r, ".env absent from history")?.level).toBe("ok");
    expect(find(r, "no API key in tracked files")?.level).toBe("ok");
  });

  it("fails when .env is tracked, even though .gitignore names it", async () => {
    const dir = repo((d) => {
      writeFileSync(join(d, ".env"), `ANTHROPIC_API_KEY=${fakeKey("committedbymistake")}\n`);
      execFileSync("git", ["add", "-f", ".env"], { cwd: d, stdio: "ignore" });
      // Added to .gitignore *after* the file was staged: the exact state where reading .gitignore
      // would report all clear while git is still tracking the file.
      writeFileSync(join(d, ".gitignore"), ".env\n");
    });
    const r = await run(dir);
    expect(r.ok).toBe(false);
    expect(find(r, ".env is untracked")?.level).toBe("fail");
    expect(find(r, ".env absent from history")?.level).toBe("fail");
  });

  it("fails when a key was committed and then deleted, because history keeps it", async () => {
    const dir = repo((d) => writeFileSync(join(d, ".env"), `ANTHROPIC_API_KEY=${fakeKey("oopsleaked")}\n`));
    execFileSync("git", ["rm", "-q", ".env"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "remove secret", "--no-verify"], { cwd: dir, stdio: "ignore" });

    const r = await run(dir);
    // Gone from the tip...
    expect(find(r, ".env is untracked")?.level).toBe("ok");
    // ...and still a failure, which is the whole reason this check exists separately.
    expect(find(r, ".env absent from history")?.level).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("fails when a key is pasted into a tracked file", async () => {
    const dir = repo((d) => writeFileSync(join(d, "config.ts"), `export const key = "${fakeKey("api03pastedintosource")}";\n`));
    const r = await run(dir);
    expect(find(r, "no API key in tracked files")?.level).toBe("fail");
    expect(find(r, "no API key in tracked files")?.detail).toContain("config.ts");
  });

  it("fails when .env.example carries a credential, but not for the mock app's synthetic login", async () => {
    const withKey = repo((d) => writeFileSync(join(d, ".env.example"), `ANTHROPIC_API_KEY=${fakeKey("inthetemplate")}\n`));
    expect(find(await run(withKey), ".env.example carries no key")?.level).toBe("fail");

    const synthetic = repo((d) => writeFileSync(join(d, ".env.example"), "ANTHROPIC_API_KEY=\nTARGET_USER=demo\nTARGET_PASSWORD=demo\n"));
    const r = await run(synthetic);
    expect(find(r, ".env.example carries no key")?.level).toBe("ok");
    expect(find(r, ".env.example passwords")?.level).toBe("warn");
    expect(r.ok).toBe(true); // a warning is not a failure
  });

  it("reports an invalid policy.yaml as a failure", async () => {
    const dir = repo((d) => writeFileSync(join(d, "policy.yaml"), "version: 1\nallowedOrigins: []\n"));
    const r = await run(dir);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => c.name === "policy.yaml" && c.level === "fail")).toBe(true);
  });

  it("falls back to the built-in policy with a warning when there is no policy.yaml", async () => {
    const dir = repo((d) => writeFileSync(join(d, "README.md"), "#\n"));
    const r = await run(dir);
    expect(find(r, "policy.yaml")?.detail).toContain("built-in defaults");
    expect(find(r, "policy.yaml present")?.level).toBe("warn");
  });

  it("never prints the key it checked", async () => {
    const dir = repo((d) => writeFileSync(join(d, ".gitignore"), ".env\n"));
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = fakeKey("supersecretvalue");
    try {
      const r = await run(dir);
      expect(JSON.stringify(r)).not.toContain("supersecretvalue");
      expect(find(r, "ANTHROPIC_API_KEY")?.level).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("checks the same file a run would read, when $CUA_POLICY names one", async () => {
    // doctor answering about a different file than runPolicy() reads would make the one command
    // whose job is "which rules are in force?" the one command that can be wrong about it.
    const dir = repo((d) => writeFileSync(join(d, "policy.yaml"), "version: 1\nallowedOrigins: []\n"));
    const other = repo((d) => writeFileSync(join(d, "README.md"), "#\n"));
    const prev = process.env["CUA_POLICY"];
    process.env["CUA_POLICY"] = join(dir, "policy.yaml");
    try {
      // Run against a directory with no policy of its own: the env var must still be what is checked.
      const r = await run(other);
      expect(r.ok).toBe(false);
      expect(r.checks.some((c) => c.name === "policy.yaml" && c.level === "fail")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["CUA_POLICY"];
      else process.env["CUA_POLICY"] = prev;
    }
  });
});

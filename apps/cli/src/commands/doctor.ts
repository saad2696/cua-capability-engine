/**
 * cua doctor — is this checkout safe and ready to run?
 *
 * Every check answers a question someone actually gets wrong. The one that matters most is whether
 * `.env` is tracked: this repository is published at the end of the exercise, and a key committed
 * once stays in the history after it is deleted from the tip. That check asks git, not `.gitignore`.
 * A `.gitignore` entry proves an intention; `git ls-files` proves the outcome, and the two differ
 * exactly when a file was added before the ignore rule was — which is the case that bites.
 *
 * Exit codes: 0 all good (warnings allowed), 2 at least one failure.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadPolicy } from "@cua/engine";

type Level = "ok" | "warn" | "fail";
interface Check {
  name: string;
  level: Level;
  detail: string;
}

const MARK: Record<Level, string> = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };

/** Run a git command, returning undefined when git is unavailable or the command fails. */
function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function checkSecretsNotTracked(root: string, out: Check[]): void {
  const isRepo = git(["rev-parse", "--is-inside-work-tree"], root) === "true";
  if (!isRepo) {
    out.push({ name: ".env is untracked", level: "warn", detail: "not a git repository; cannot verify" });
    return;
  }

  // Tracked right now?
  const tracked = git(["ls-files", "--", ".env", "*.env", "**/.env"], root);
  if (tracked) out.push({ name: ".env is untracked", level: "fail", detail: `git is tracking: ${tracked.split("\n").join(", ")} — remove it before publishing` });
  else out.push({ name: ".env is untracked", level: "ok", detail: "git ls-files reports no .env" });

  // Ever committed? Deleting a secret from the tip does not remove it from history.
  const everCommitted = git(["log", "--all", "--oneline", "--", ".env"], root);
  if (everCommitted) out.push({ name: ".env absent from history", level: "fail", detail: `committed in: ${everCommitted.split("\n")[0]} — rewrite history or rotate the key` });
  else out.push({ name: ".env absent from history", level: "ok", detail: "no commit has ever touched .env" });

  // A key can also leak by being pasted into a tracked file.
  const leaked = git(["grep", "-l", "-E", "sk-ant-[A-Za-z0-9_-]{8}", "HEAD"], root);
  if (leaked) out.push({ name: "no API key in tracked files", level: "fail", detail: `key-shaped string in: ${leaked.split("\n").join(", ")}` });
  else out.push({ name: "no API key in tracked files", level: "ok", detail: "no key-shaped string at HEAD" });

  // The committed template must stay a template. Only credential-shaped names are failures:
  // TARGET_USER=demo and TARGET_PASSWORD=demo are the mock app's synthetic logins and are meant to
  // be committed, so flagging every assigned variable would cry wolf on the one file that has to
  // stay readable. A password-shaped variable is still worth a second look, hence the warning.
  const examplePath = join(root, ".env.example");
  if (existsSync(examplePath)) {
    const assigned = readFileSync(examplePath, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .map((l) => /^([A-Z0-9_]+)\s*=\s*(\S.*)?$/.exec(l))
      .flatMap((m) => (m?.[1] && m[2] ? [{ name: m[1], value: m[2].trim() }] : []));

    const secrets = assigned.filter((v) => /(_KEY|_TOKEN|_SECRET|SECRET)$/.test(v.name));
    const passwords = assigned.filter((v) => /PASSWORD|PASSPHRASE/.test(v.name));

    if (secrets.length)
      out.push({ name: ".env.example carries no key", level: "fail", detail: `${secrets.map((v) => v.name).join(", ")} has a value in a committed file` });
    else out.push({ name: ".env.example carries no key", level: "ok", detail: "every credential variable is left blank" });

    if (passwords.length)
      out.push({
        name: ".env.example passwords",
        level: "warn",
        detail: `${passwords.map((v) => `${v.name}=${v.value}`).join(", ")} — fine while these are the mock app's synthetic logins; never a real one`,
      });
  }
}

function checkEnv(out: Check[]): void {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) out.push({ name: "ANTHROPIC_API_KEY", level: "warn", detail: "not set — discovery with --provider anthropic will not run; replay and the fake provider are unaffected" });
  else if (!key.startsWith("sk-ant-")) out.push({ name: "ANTHROPIC_API_KEY", level: "warn", detail: "set, but not in the expected sk-ant- form" });
  else out.push({ name: "ANTHROPIC_API_KEY", level: "ok", detail: `set (${key.length} chars, not shown)` });

  for (const name of ["TARGET_USER", "TARGET_PASSWORD"]) {
    out.push(
      process.env[name]
        ? { name, level: "ok", detail: "set (not shown)" }
        : { name, level: "warn", detail: "not set — the login prelude will fall back to the artifact's defaults" },
    );
  }
}

function checkPolicy(root: string, out: Check[]): string[] {
  // Resolve exactly the way `runPolicy()` does, or this command answers "which rules ran?" about a
  // different file than the one a run reads — which is the single question it exists to answer.
  const path = process.env["CUA_POLICY"] ?? join(root, "policy.yaml");
  const loaded = loadPolicy(path);
  if (!loaded.ok) {
    for (const i of loaded.issues) out.push({ name: "policy.yaml", level: "fail", detail: `${i.path}: ${i.message}` });
    return [];
  }
  out.push({
    name: "policy.yaml",
    level: "ok",
    detail: `${loaded.source}${process.env["CUA_POLICY"] ? " (via $CUA_POLICY)" : ""} — ${loaded.policy.allowedOrigins.length} origin(s), ${loaded.policy.blockedUrlPatterns.length} blocked pattern(s), risky steps require ${loaded.policy.replay.riskyStepsRequire}`,
  });
  if (loaded.source === "built-in defaults") out.push({ name: "policy.yaml present", level: "warn", detail: `no ${path}; the built-in defaults are in force` });
  return loaded.policy.allowedOrigins;
}

async function checkReachable(origins: string[], out: Check[]): Promise<void> {
  for (const origin of origins) {
    try {
      const res = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(3000) });
      out.push({ name: `target ${origin}`, level: res.status < 500 ? "ok" : "warn", detail: `HTTP ${res.status}` });
    } catch {
      out.push({ name: `target ${origin}`, level: "warn", detail: "not reachable — start it with `pnpm dev:target`" });
    }
  }
}

export async function doctorCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false }, "skip-network": { type: "boolean", default: false } } });
  // The CLI runs from the repo root via `pnpm cua`; allow an override for other layouts.
  const root = process.env["CUA_ROOT"] ?? process.cwd();

  const checks: Check[] = [];
  checkSecretsNotTracked(root, checks);
  checkEnv(checks);
  const origins = checkPolicy(root, checks);
  if (!values["skip-network"]) await checkReachable(origins, checks);

  const failed = checks.filter((c) => c.level === "fail");
  const warned = checks.filter((c) => c.level === "warn");

  if (values.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    console.log(`\ncua doctor — ${root}\n`);
    for (const c of checks) console.log(`  [${MARK[c.level]}] ${c.name.padEnd(28)} ${c.detail}`);
    console.log(
      `\n  ${checks.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s)` +
        (failed.length ? "\n  Fix the failures before publishing this repository.\n" : "\n"),
    );
  }
  process.exitCode = failed.length ? 2 : 0;
}

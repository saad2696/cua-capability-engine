/**
 * cua evidence index — regenerate the run table in evidence/README.md.
 *
 * The table is the part a machine should own: what ran, what came back, how many steps, what it
 * cost. Everything else in that file — what the runs are *for*, and the paragraph distinguishing
 * what is redacted from what is not — is written by a person and must survive regeneration, so the
 * generator only ever replaces the block between two markers and refuses to touch a file that does
 * not have them. A generator that overwrites prose is one nobody runs twice.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const BEGIN = "<!-- BEGIN generated run index — `cua evidence index` -->";
const END = "<!-- END generated run index -->";

interface Row {
  dir: string;
  kind: "discovery" | "replay" | "handover" | "observation" | "other";
  outcome: string;
  detail: string;
  steps: string;
  cost: string;
}

const money = (n: unknown): string => (typeof n === "number" && n > 0 ? `$${n.toFixed(4)}` : "—");

/** Read whichever summary a run directory happens to carry. */
function summarise(root: string, dir: string): Row | undefined {
  const path = join(root, dir);
  if (!statSync(path).isDirectory()) return undefined;

  const read = (f: string): Record<string, unknown> | undefined => {
    const p = join(path, f);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  // A handover is a replay that a person took part in, and the interventions are the interesting
  // part, so they decide the label even though a result file is also present.
  const interventions = read("interventions.json") as unknown;
  const ivList = Array.isArray(interventions) ? (interventions as { reason?: string; status?: string }[]) : undefined;

  const result = read("result.json");
  if (result) {
    const code = [result["code"], result["reason"]].filter(Boolean).join(" ");
    const outputs = result["outputs"] ? JSON.stringify(result["outputs"]) : "";
    const message = String(result["message"] ?? result["detail"] ?? "");
    return {
      dir,
      kind: ivList?.length ? "handover" : "replay",
      outcome: `${String(result["status"]).toUpperCase()}${code ? ` ${code}` : ""}`,
      detail: [outputs, message].filter(Boolean).join(" · ").slice(0, 120) || "—",
      steps: String(result["stepsRun"] ?? "—"),
      cost: ivList?.length
        ? `${ivList.length} intervention${ivList.length === 1 ? "" : "s"}: ${ivList.map((i) => `${i.reason ?? "?"}→${i.status ?? "?"}`).join(", ")}`
        : `side effects: ${String(result["sideEffects"] ?? "—")}`,
    };
  }

  const run = read("run.json");
  if (run) {
    const usage = (run["usage"] ?? {}) as Record<string, unknown>;
    return {
      dir,
      kind: "discovery",
      outcome: String(run["status"] ?? "—").toUpperCase(),
      detail: String(run["artifactPath"] ?? run["goal"] ?? "—").slice(0, 120),
      steps: String(run["stepsTaken"] ?? "—"),
      cost: usage["model"] ? `${String(usage["model"])} · ${money(usage["estimatedCostUsd"])}` : "—",
    };
  }

  // A handover that never produced a result still has its trail.
  if (ivList) {
    return {
      dir,
      kind: "handover",
      outcome: `${ivList.length} intervention${ivList.length === 1 ? "" : "s"}`,
      detail: ivList.map((i) => `${i.reason ?? "?"} → ${i.status ?? "?"}`).join(", ").slice(0, 120) || "—",
      steps: "—",
      cost: "—",
    };
  }

  // A perception capture: no run, but it is evidence and listing it keeps the index honest about
  // everything on disk rather than only the things that fit the run shape.
  const obs = read("observation.json");
  if (obs) {
    const elements = Array.isArray(obs["elements"]) ? (obs["elements"] as unknown[]).length : undefined;
    return { dir, kind: "observation", outcome: "CAPTURED", detail: String(obs["url"] ?? "—").slice(0, 120), steps: elements ? `${elements} elements` : "—", cost: "—" };
  }

  // Anything else that holds images is still worth a row; silence would hide it.
  const files = readdirSync(path);
  const shots = (existsSync(join(path, "screenshots")) ? readdirSync(join(path, "screenshots")) : files).filter((f) => f.endsWith(".png")).length;
  if (!shots) return undefined;
  return { dir, kind: "other", outcome: "—", detail: `${shots} screenshots, no summary file`, steps: "—", cost: "—" };
}

export function evidenceCommand(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dir: { type: "string", default: "evidence" }, check: { type: "boolean", default: false } },
  });
  if (positionals[0] !== "index") {
    console.error("usage: cua evidence index [--dir evidence] [--check]");
    process.exitCode = 1;
    return;
  }

  const root = values.dir;
  const readme = join(root, "README.md");
  if (!existsSync(readme)) {
    console.error(`${readme} does not exist; the index is written into it, not over it.`);
    process.exitCode = 2;
    return;
  }
  const before = readFileSync(readme, "utf8");
  if (!before.includes(BEGIN) || !before.includes(END)) {
    console.error(`${readme} has no generated-index markers. Add these two lines where the table belongs:\n  ${BEGIN}\n  ${END}`);
    process.exitCode = 2;
    return;
  }

  const rows = readdirSync(root)
    .sort()
    .flatMap((d) => {
      const r = summarise(root, d);
      return r ? [r] : [];
    });

  const table = [
    `_${rows.length} run${rows.length === 1 ? "" : "s"}. Regenerate with \`pnpm cua evidence index\`._`,
    "",
    "| run | kind | outcome | detail | steps | notes |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| \`${r.dir}/\` | ${r.kind} | ${r.outcome} | ${r.detail} | ${r.steps} | ${r.cost} |`),
  ].join("\n");

  const start = before.indexOf(BEGIN) + BEGIN.length;
  const end = before.indexOf(END);
  const after = `${before.slice(0, start)}\n\n${table}\n\n${before.slice(end)}`;

  if (values.check) {
    const same = after === before;
    console.log(same ? `${readme} is up to date (${rows.length} runs).` : `${readme} is stale; run \`cua evidence index\`.`);
    process.exitCode = same ? 0 : 1;
    return;
  }
  if (after === before) {
    console.log(`${readme} already up to date (${rows.length} runs).`);
    return;
  }
  writeFileSync(readme, after);
  console.log(`${readme}: indexed ${rows.length} runs.`);
}

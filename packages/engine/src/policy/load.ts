/**
 * The one way a run gets its policy.
 *
 * Every entry point — `cua replay`, `cua discover`, and both run kinds in the server — goes through
 * here, so `policy.yaml` is the document in force rather than a file that merely happens to agree
 * with the constants in `schema.ts`. That distinction is the whole claim the README makes about this
 * file, and it is only true if editing the file changes what a run does.
 *
 * Origins are the exception, and are passed in rather than read. A replay's permitted origin comes
 * from the artifact it is replaying and a discovery's from the URL it was pointed at; the test suite
 * binds the mock app to an ephemeral port on every run, so a fixed origin in a file could not
 * describe either. Everything else — the blocked paths, the irreversible lists, the escalation
 * modes, the budgets — comes from the document.
 *
 * An invalid policy is fatal. `cua doctor` exists to report the problem legibly, but a run that
 * cannot read its own guardrails must not fall back to defaults and proceed: that turns a typo into
 * a silent widening of what the engine may touch.
 */
import { join } from "node:path";
import { policyGate, type DiscoveryPolicy } from "./basic.js";
import { loadPolicy, type Policy } from "./schema.js";

export class PolicyLoadError extends Error {
  constructor(
    readonly source: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(`policy is invalid (${source}):\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}\nRun \`cua doctor\` for the full report.`);
    this.name = "PolicyLoadError";
  }
}

export interface RunPolicyOptions {
  /** Origins this particular run may reach; overrides the file, which cannot know them. */
  origins: string[];
  /** Defaults to `$CUA_POLICY`, then `policy.yaml` in the working directory. */
  path?: string;
}

export interface RunPolicy {
  gate: DiscoveryPolicy;
  policy: Policy;
  /** The file it came from, or "built-in defaults". Worth logging: it answers "which rules ran?". */
  source: string;
}

export function runPolicy(opts: RunPolicyOptions): RunPolicy {
  const path = opts.path ?? process.env["CUA_POLICY"] ?? join(process.cwd(), "policy.yaml");
  const loaded = loadPolicy(path);
  if (!loaded.ok) throw new PolicyLoadError(loaded.source, loaded.issues);

  const policy: Policy = { ...loaded.policy, allowedOrigins: opts.origins.length ? opts.origins : loaded.policy.allowedOrigins };
  return { gate: policyGate(policy), policy, source: loaded.source };
}

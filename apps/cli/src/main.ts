#!/usr/bin/env node
/**
 * cua — command line entry point.
 */
import "dotenv/config";
import { ENGINE_NAME, PolicyLoadError, SCHEMA_VERSION } from "@cua/engine";
import { artifactCommand } from "./commands/artifact.js";
import { observeCommand } from "./commands/observe.js";
import { discoverCommand } from "./commands/discover.js";
import { replayCommand } from "./commands/replay.js";
import { serveCommand } from "./commands/serve.js";
import { doctorCommand } from "./commands/doctor.js";

const [command = "help", ...rest] = process.argv.slice(2);

function help(): void {
  console.log(`${ENGINE_NAME} (schema ${SCHEMA_VERSION})

Usage: cua <command>

Commands:
  help        show this message
  version     print engine and schema versions
  artifact    validate | summary <file.json>
  observe     <url> [--out dir] [--headed]   perceive a page: a11y elements + marked screenshot
  discover    --goal "..." --url <url> --capability-id <id> [--param k=v] [--provider anthropic|fake]
              budgets and risk modes default to policy.yaml; flags override
  replay      <artifact.json> [--param k=v] [--plan] [--allow-draft] [--fault <name>[:sticky]] [--headed]
  serve       [--port 4200] [--headed]   control plane for the operator console (loopback only)
  doctor      [--json] [--skip-network]  check secrets, policy and target before a run

Run \`cua doctor\` first: it verifies that no secret is tracked by git and that policy.yaml is valid.`);
}

/**
 * Every outcome the CLI can produce is a typed one with a defined exit code (docs/error-taxonomy.md).
 * A policy that will not load is a guardrail failure, so it exits 2 with the issues listed rather
 * than a stack trace — this is the error most likely to be hit by someone who just edited
 * policy.yaml, and it should read like the checker does.
 */
try {
  switch (command) {
    case "doctor":
      await doctorCommand(rest);
      break;
    case "serve":
      await serveCommand(rest);
      break;
    case "replay":
      await replayCommand(rest);
      break;
    case "discover":
      await discoverCommand(rest);
      break;
    case "observe":
      await observeCommand(rest);
      break;
    case "artifact":
      artifactCommand(rest);
      break;
    case "version":
      console.log(`${ENGINE_NAME} schema=${SCHEMA_VERSION}`);
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      help();
      process.exitCode = 1;
  }
} catch (err) {
  if (err instanceof PolicyLoadError) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 2;
  } else throw err;
}

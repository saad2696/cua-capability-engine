#!/usr/bin/env node
/**
 * cua — command line entry point.
 *
 * Commands arrive in later slices:
 *   serve     (007)  start the engine server used by the operator console
 *   doctor    (009)  check environment, secrets, policy, target reachability
 */
import "dotenv/config";
import { ENGINE_NAME, SCHEMA_VERSION } from "@cua/engine";
import { artifactCommand } from "./commands/artifact.js";
import { observeCommand } from "./commands/observe.js";
import { discoverCommand } from "./commands/discover.js";
import { replayCommand } from "./commands/replay.js";

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
  replay      <artifact.json> [--param k=v] [--plan] [--allow-draft] [--fault <name>[:sticky]] [--headed]

More commands are added slice by slice; see openspec/ROADMAP.md.`);
}

switch (command) {
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

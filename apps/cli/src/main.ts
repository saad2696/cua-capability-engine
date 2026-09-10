#!/usr/bin/env node
/**
 * cua — command line entry point.
 *
 * Commands arrive in later slices:
 *   observe   (004)  dump an annotated screenshot + element list for a URL
 *   discover  (005)  run the LLM-driven discovery loop and save a capability artifact
 *   replay    (006)  replay an artifact deterministically with parameters
 *   serve     (007)  start the engine server used by the operator console
 *   doctor    (009)  check environment, secrets, policy, target reachability
 */
import "dotenv/config";
import { ENGINE_NAME, SCHEMA_VERSION } from "@cua/engine";
import { artifactCommand } from "./commands/artifact.js";

const [command = "help", ...rest] = process.argv.slice(2);

function help(): void {
  console.log(`${ENGINE_NAME} (schema ${SCHEMA_VERSION})

Usage: cua <command>

Commands:
  help        show this message
  version     print engine and schema versions
  artifact    validate | summary <file.json>

More commands are added slice by slice; see openspec/ROADMAP.md.`);
}

switch (command) {
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

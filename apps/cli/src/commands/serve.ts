/**
 * cua serve [--port 4200] [--headed] [--evidence <dir>] [--artifacts <dir>]
 *
 * The control plane for the operator console. Binds to loopback only.
 */
import { parseArgs } from "node:util";
import { startServer } from "@cua/engine";

const SECRET_ENV = ["TARGET_USER", "TARGET_PASSWORD"];

export async function serveCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      port: { type: "string", default: process.env["CUA_SERVER_PORT"] ?? "4200" },
      headed: { type: "boolean", default: false },
      evidence: { type: "string", default: process.env["CUA_EVIDENCE_DIR"] ?? "evidence" },
      artifacts: { type: "string", default: "artifacts" },
      "intervention-timeout": { type: "string" },
    },
  });
  const secrets: Record<string, string> = {};
  for (const name of SECRET_ENV) if (process.env[name]) secrets[name] = process.env[name]!;

  const running = await startServer(Number(values.port), {
    evidenceDir: values.evidence, artifactsDir: values.artifacts, secrets,
    headless: !values.headed,
    ...(values["intervention-timeout"] ? { interventionTimeoutMs: Number(values["intervention-timeout"]) } : {}),
  });

  const base = `http://127.0.0.1:${running.port}`;
  console.log(`cua serve listening on ${base} (loopback only)`);
  console.log(`  runs         GET  ${base}/api/runs`);
  console.log(`  start replay POST ${base}/api/replay   {"artifactPath":"member-savings-balance@2.json","params":{"memberId":"10042"}}`);
  console.log(`  live events  GET  ${base}/api/runs/:id/events   (server-sent events)`);
  console.log(`  pause        POST ${base}/api/runs/:id/pause`);
  console.log(`  scenario     POST ${base}/api/runs/:id/scenario {"fault":"session_expired"}`);
  console.log(`  take control WS   ws://127.0.0.1:${running.port}/ws/runs/:id/live`);
  console.log(`  secrets loaded: ${Object.keys(secrets).join(", ") || "none"}`);

  const shutdown = () => {
    console.log("\nshutting down");
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run until interrupted
}

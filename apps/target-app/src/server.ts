/**
 * Legacy CU Core — mock target application.
 *
 * Slice 002 builds the real thing: frameset shell, login, member search, member detail,
 * sub-account form, confirm, done, plus fault injection. This placeholder only proves the
 * package boots.
 */
import "dotenv/config";
import express from "express";

export function createApp(): express.Express {
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, app: "legacy-cu-core" });
  });
  return app;
}

const port = Number(process.env.TARGET_APP_PORT ?? 4100);
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  createApp().listen(port, () => {
    console.log(`Legacy CU Core listening on http://localhost:${port}`);
  });
}

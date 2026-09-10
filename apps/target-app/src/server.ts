/**
 * Legacy CU Core — mock target application (see openspec/changes/002-target-app-legacy-cu-core).
 *
 * Deliberately legacy: frameset shell, table layouts, no element ids, inline onclick handlers,
 * labels as adjacent table cells, a native confirm() on the irreversible step. Fault injection
 * lets tests and demos trigger every runtime error class the brief names.
 *
 * Synthetic data only. Credentials default to demo/demo and can be overridden by env.
 */
import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import { MemberStore } from "./data/members.js";
import { faultMiddleware } from "./faults.js";
import { buildRouter, type AppDeps } from "./routes.js";
import { SessionStore } from "./session.js";

export interface CreateAppOptions {
  credentials?: { user: string; password: string };
}

export function createApp(opts: CreateAppOptions = {}): { app: express.Express; deps: AppDeps } {
  const deps: AppDeps = {
    members: new MemberStore(),
    sessions: new SessionStore(),
    credentials: opts.credentials ?? {
      user: process.env["TARGET_USER"] ?? "demo",
      password: process.env["TARGET_PASSWORD"] ?? "demo",
    },
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));
  app.use(faultMiddleware);
  app.use(buildRouter(deps));
  return { app, deps };
}

const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  const port = Number(process.env["TARGET_APP_PORT"] ?? 4100);
  createApp().app.listen(port, () => {
    console.log(`Legacy CU Core listening on http://localhost:${port}  (sign in: ${process.env["TARGET_USER"] ?? "demo"} / ****)`);
  });
}

/**
 * The control plane: HTTP for commands and history, SSE for the event stream, WebSocket for the
 * live session. Bound to loopback only — there is no authentication here, and the API can drive a
 * browser, so it must not be reachable from anywhere but this machine.
 *
 * Everything the operator console (slice 008) needs is here, and all of it is exercisable with curl
 * and a ten-line WebSocket script, which is the point: the UI is a client of a real API rather than
 * a thing with an engine bolted to it.
 */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { validateCapability } from "@cua/schema";
import { AnthropicProvider } from "../llm/AnthropicProvider.js";
import type { LlmProvider } from "../llm/types.js";
import { FrameStreamer, applyInput, type InputMessage } from "./live.js";
import { RunRegistry, type RunRecord } from "./RunRegistry.js";

export interface ServerOptions {
  evidenceDir?: string;
  artifactsDir?: string;
  /** Secrets handed to replays started through the API. Never echoed back. */
  secrets?: Record<string, string>;
  headless?: boolean;
  interventionTimeoutMs?: number;
  /**
   * Provider factory for discovery runs. Injected so the console can be demonstrated with the
   * scripted fake provider — no API key, no cost, same pipeline — and switched to a real model
   * without changing the server.
   */
  provider?: (name?: string) => LlmProvider;
}

const publicRun = (r: RunRecord) => ({
  id: r.id, kind: r.kind, capabilityId: r.capabilityId, capabilityVersion: r.capabilityVersion,
  params: r.params, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
  evidenceDir: r.evidenceDir, session: r.session.toJSON(), result: r.result, discovery: r.discovery,
});

export function createServerApp(opts: ServerOptions = {}): { app: Express; registry: RunRegistry } {
  const evidenceRoot = opts.evidenceDir ?? "evidence";
  const artifactsDir = opts.artifactsDir ?? "artifacts";
  const registry = new RunRegistry(evidenceRoot);
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const notFound = (res: Response, what: string) => res.status(404).json({ error: what });

  // ---- runs ----
  app.get("/api/runs", (_req, res) => void res.json(registry.list().map(publicRun)));

  app.get("/api/runs/:id", (req, res) => {
    const r = registry.get(String(req.params.id));
    if (!r) return void notFound(res, "run");
    res.json(publicRun(r));
  });

  app.post("/api/replay", (req, res) => {
    void (async () => {
      const body = req.body as { artifactPath?: string; artifact?: unknown; params?: Record<string, string>; fault?: { name: string; sticky?: boolean }; headless?: boolean; allowDraft?: boolean };
      const raw = body.artifact ?? (body.artifactPath ? readJson(artifactsDir, body.artifactPath) : undefined);
      if (!raw) return void res.status(400).json({ error: "artifact or artifactPath is required" });
      const check = validateCapability(raw);
      if (!check.ok) return void res.status(400).json({ error: "invalid artifact", issues: check.issues });
      const run = await registry.startReplay({
        artifact: raw, params: body.params ?? {}, secrets: opts.secrets ?? {},
        ...(body.fault ? { fault: body.fault } : {}),
        headless: body.headless ?? opts.headless ?? true,
        allowDraft: body.allowDraft ?? true,
        ...(opts.interventionTimeoutMs ? { interventionTimeoutMs: opts.interventionTimeoutMs } : {}),
      });
      res.status(201).json(publicRun(run));
    })().catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  /** Server-sent events: the run's evidence log, live, plus a replay of what it missed. */
  app.get("/api/runs/:id/events", (req: Request, res: Response) => {
    const r = registry.get(String(req.params.id));
    if (!r) return void notFound(res, "run");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (data: unknown, event = "message") => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const e of r.recent) send(e);
    send(publicRun(r), "run");
    const offEvent = r.evidence.subscribe((e) => send(e));
    const offRun = registry.onChange((changed) => { if (changed.id === r.id) send(publicRun(changed), "run"); });
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
    keepAlive.unref?.();
    req.on("close", () => { offEvent(); offRun(); clearInterval(keepAlive); });
  });

  // ---- session control ----
  app.post("/api/runs/:id/pause", (req, res) => {
    void (async () => {
      const r = registry.get(String(req.params.id));
      if (!r) return void notFound(res, "run");
      const iv = await r.session.pause(String((req.body as { by?: string }).by ?? "operator"));
      res.status(201).json(iv);
    })().catch((e: Error) => res.status(409).json({ error: e.message }));
  });

  /**
   * Arm one of the mock application's faults inside the *running* browser, so the next thing the
   * flow does hits it. This is what turns the console's scenario buttons into a demonstration of
   * recovery rather than a re-run with different flags.
   */
  app.post("/api/runs/:id/scenario", (req, res) => {
    void (async () => {
      const body = req.body as { fault?: string; sticky?: boolean };
      if (!body.fault) return void res.status(400).json({ error: "fault is required" });
      await registry.injectScenario(String(req.params.id), body.fault, body.sticky ?? false);
      res.json({ ok: true, fault: body.fault, sticky: body.sticky ?? false });
    })().catch((e: Error) => res.status(400).json({ error: e.message }));
  });

  app.post("/api/runs/:id/abort", (req, res) => {
    const r = registry.get(String(req.params.id));
    if (!r) return void notFound(res, "run");
    r.session.abort();
    res.json(publicRun(r));
  });

  // ---- interventions ----
  app.get("/api/interventions", (_req, res) => {
    res.json(registry.list().flatMap((r) => r.session.allInterventions.map((i) => ({ ...i, runStatus: r.status }))));
  });

  app.post("/api/interventions/:id/claim", (req, res) => {
    const run = registry.findByIntervention(String(req.params.id));
    if (!run) return void notFound(res, "intervention");
    try {
      const { intervention } = run.session.claim(String(req.params.id), String((req.body as { by?: string }).by ?? "operator"));
      res.json({ ...intervention, runId: run.id, sessionId: run.session.id });
    } catch (e) {
      // A second operator arriving at the same intervention is an expected race, not a server fault.
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.post("/api/interventions/:id/resolve", (req, res) => {
    const run = registry.findByIntervention(String(req.params.id));
    if (!run) return void notFound(res, "intervention");
    const body = req.body as { resumeAt?: "same" | "next" | "abort"; note?: string; by?: string };
    if (!body.resumeAt) return void res.status(400).json({ error: "resumeAt is required: same | next | abort" });
    try {
      run.session.resolve(String(req.params.id), body.resumeAt, body.by ?? "operator", body.note);
      res.json(publicRun(run));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // ---- artifacts ----
  app.get("/api/artifacts", (_req, res) => {
    if (!existsSync(artifactsDir)) return void res.json([]);
    const files = readdirSync(artifactsDir).filter((f) => f.endsWith(".json"));
    res.json(files.map((f) => {
      const cap = JSON.parse(readFileSync(join(artifactsDir, f), "utf8")) as { capability: { id: string; version: number; name: string; status: string }; inputs: Record<string, unknown>; outputs: Record<string, unknown> };
      return { file: f, id: cap.capability.id, version: cap.capability.version, name: cap.capability.name, status: cap.capability.status, inputs: Object.keys(cap.inputs), outputs: Object.keys(cap.outputs) };
    }));
  });

  app.get("/api/artifacts/:file", (req, res) => {
    const raw = readJson(artifactsDir, String(req.params.file));
    if (!raw) return void notFound(res, "artifact");
    res.json(raw);
  });

  app.post("/api/discover", (req, res) => {
    void (async () => {
      const body = req.body as { goal?: string; url?: string; capabilityId?: string; params?: Record<string, string>; maxSteps?: number; provider?: string; headless?: boolean };
      if (!body.goal || !body.url) return void res.status(400).json({ error: "goal and url are required" });
      const make = opts.provider ?? ((name?: string) => new AnthropicProvider(name ? { model: name } : {}));
      let provider: LlmProvider;
      try {
        provider = make(body.provider);
      } catch (e) {
        // Missing key is the common case, and it deserves a clear answer rather than a 500.
        return void res.status(400).json({ error: `no model provider available: ${(e as Error).message}` });
      }
      const run = await registry.startDiscovery({
        goal: body.goal, url: body.url, capabilityId: body.capabilityId ?? "discovered-capability",
        provider, params: body.params ?? {}, secrets: opts.secrets ?? {},
        ...(body.maxSteps ? { maxSteps: body.maxSteps } : {}),
        headless: body.headless ?? opts.headless ?? true,
        ...(opts.interventionTimeoutMs ? { interventionTimeoutMs: opts.interventionTimeoutMs } : {}),
      });
      res.status(201).json(publicRun(run));
    })().catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  app.get("/api/health", (_req, res) => void res.json({ ok: true, runs: registry.list().length }));

  return { app, registry };
}

function readJson(dir: string, file: string): unknown {
  const path = file.includes("/") ? file : join(dir, file);
  if (!existsSync(path) || file.includes("..")) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export interface RunningServer {
  server: Server;
  port: number;
  registry: RunRegistry;
  close(): Promise<void>;
}

/** Start the HTTP server and attach the WebSocket live channel. Loopback only. */
export async function startServer(port = 4200, opts: ServerOptions = {}): Promise<RunningServer> {
  const { app, registry } = createServerApp(opts);
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const m = /^\/ws\/runs\/([^/?]+)\/live/.exec(req.url ?? "");
    const run = m ? registry.get(String(m[1])) : undefined;
    if (!run) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => attachLive(ws, run));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as { port: number }).port;
  return {
    server, port: actual, registry,
    async close() {
      wss.close();
      await registry.stopAll();
      // Server-sent event streams are deliberately long-lived, so a plain close() waits forever for
      // consoles that are still attached. Shutting down means dropping them, not outliving them.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * One operator socket: frames out while the run is stopped, inputs in while they hold the lease.
 *
 * The socket never gets a lease of its own. It asks the session to claim the intervention, and the
 * session hands back a leased surface — so a console that forgets to claim simply cannot act, and
 * the failure is a clear message rather than a silent write to somebody else's browser.
 */
function attachLive(ws: WebSocket, run: RunRecord): void {
  let leased: ReturnType<RunRecord["session"]["claim"]>["surface"] | undefined;
  const streamer = new FrameStreamer(run.surface, run.session, (f) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f));
  });
  streamer.start();
  run.session.operatorReconnected();

  const say = (o: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o));
  };
  say({ type: "hello", runId: run.id, sessionId: run.session.id, state: run.session.state, interventions: run.session.openInterventions });

  ws.on("message", (data) => {
    void (async () => {
      const msg = JSON.parse(String(data)) as { type: string } & Record<string, unknown>;
      if (msg.type === "claim") {
        const id = String(msg.interventionId ?? run.session.openInterventions[0]?.id ?? "");
        const claimed = run.session.claim(id, String(msg.by ?? "operator"));
        leased = claimed.surface;
        return say({ type: "claimed", intervention: claimed.intervention });
      }
      if (msg.type === "resolve") {
        const id = String(msg.interventionId ?? run.session.openInterventions[0]?.id ?? "");
        run.session.resolve(id, (msg.resumeAt as "same" | "next" | "abort") ?? "same", String(msg.by ?? "operator"), msg.note ? String(msg.note) : undefined);
        leased = undefined;
        return say({ type: "resolved", state: run.session.state });
      }
      if (!leased) return say({ type: "error", error: "claim an intervention before sending input" });
      await applyInput(msg as unknown as InputMessage, leased, run.session);
      say({ type: "ack", of: msg.type });
    })().catch((e: Error) => say({ type: "error", error: e.message }));
  });

  ws.on("close", () => {
    streamer.stop();
    // Derived from the session, not from whether *this socket* did the claiming: an operator may
    // claim over HTTP and then open the socket, and their disconnect must still start the grace
    // timer. Keying off the local variable left such an intervention claimed by nobody until it
    // expired a quarter of an hour later.
    if (run.session.state === "human_control") run.session.operatorDisconnected();
  });
}

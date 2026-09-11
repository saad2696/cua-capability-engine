/**
 * Everything the console knows about the engine. One module, so there is exactly one place that
 * knows the shape of the API and one place to look when a call behaves unexpectedly.
 *
 * The console holds no engine logic of its own. It cannot take control, resolve an intervention or
 * decide what a run does next — it asks the server, which owns the state machine. That is why the
 * headless demo script and this UI can drive the same run without contradicting each other.
 */

const json = async (res) => {
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `${res.status} ${res.statusText}`), { status: res.status, body });
  return body;
};

const get = (path) => fetch(path).then(json);
const post = (path, body) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(json);

export const api = {
  health: () => get("/api/health"),
  demo: () => get("/api/demo"),

  runs: () => get("/api/runs"),
  run: (id) => get(`/api/runs/${id}`),
  startReplay: (body) => post("/api/replay", body),
  startDiscovery: (body) => post("/api/discover", body),
  pause: (id, by) => post(`/api/runs/${id}/pause`, { by }),
  abort: (id) => post(`/api/runs/${id}/abort`),
  scenario: (id, fault, sticky) => post(`/api/runs/${id}/scenario`, { fault, sticky }),

  evidence: (runId) => get(`/api/runs/${runId}/evidence`),
  /** A URL rather than a fetch: images and downloads are referenced, not read into memory. */
  evidenceFile: (runId, path) => `/api/runs/${runId}/evidence/${path}`,

  interventions: () => get("/api/interventions"),
  claim: (id, by) => post(`/api/interventions/${id}/claim`, { by }),
  resolve: (id, resumeAt, note, by) => post(`/api/interventions/${id}/resolve`, { resumeAt, note, by }),

  artifacts: () => get("/api/artifacts"),
  artifact: (file) => get(`/api/artifacts/${file}`),
  approve: (file, by) => post(`/api/artifacts/${file}/approve`, { by }),
};

/**
 * Subscribe to a run's evidence log. The server replays what a late subscriber missed before
 * streaming, so attaching to a run already in flight shows its history rather than starting blank.
 */
export function openEventStream(runId, { onEvent, onRun, onError } = {}) {
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.addEventListener("message", (e) => onEvent?.(JSON.parse(e.data)));
  source.addEventListener("run", (e) => onRun?.(JSON.parse(e.data)));
  source.addEventListener("error", () => onError?.());
  return () => source.close();
}

/**
 * The live channel. Frames arrive while a run is stopped; input is accepted only after this socket
 * has claimed an intervention, which the server enforces — the console cannot grant itself control.
 */
export function openLiveSocket(runId, handlers = {}) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/runs/${runId}/live`);
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    handlers[msg.type]?.(msg);
    handlers.any?.(msg);
  });
  ws.addEventListener("open", () => handlers.open?.());
  ws.addEventListener("close", () => handlers.close?.());
  ws.addEventListener("error", () => handlers.socketError?.());
  return {
    socket: ws,
    send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

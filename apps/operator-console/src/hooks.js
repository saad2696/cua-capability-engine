/**
 * State that follows a run. Kept apart from the components so that "what is true right now" is
 * never derived twice in two places — the same mistake that made a run's status stick on "running"
 * in the engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openEventStream, openLiveSocket } from "./api.js";

/** Poll a plain endpoint. Used for lists, where a stream would be more machinery than value. */
export function usePolled(fn, intervalMs = 2000, deps = []) {
  const [value, setValue] = useState();
  const [error, setError] = useState();
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const v = await fn();
        if (live) {
          setValue(v);
          setError(undefined);
        }
      } catch (e) {
        if (live) setError(e);
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error, reload: fn };
}

/** One run, its event log, and whatever the operator is being asked to decide. */
export function useRun(runId) {
  const [run, setRun] = useState();
  const [events, setEvents] = useState([]);
  const [streamError, setStreamError] = useState(false);

  useEffect(() => {
    if (!runId) return;
    setEvents([]);
    setRun(undefined);
    let live = true;
    api.run(runId).then((r) => live && setRun(r), () => {});
    const close = openEventStream(runId, {
      onEvent: (e) => live && setEvents((prev) => [...prev, e]),
      onRun: (r) => live && setRun(r),
      onError: () => live && setStreamError(true),
    });
    // The event stream carries run snapshots, but a run that finishes between snapshots would leave
    // the page stale, so the record is also re-read on a slow interval as a backstop.
    const t = setInterval(() => api.run(runId).then((r) => live && setRun(r), () => {}), 3000);
    return () => {
      live = false;
      close();
      clearInterval(t);
    };
  }, [runId]);

  const openIntervention = useMemo(
    () => run?.session?.interventions?.find((i) => i.status === "open" || i.status === "claimed"),
    [run],
  );

  return { run, events, openIntervention, streamError };
}

/**
 * The live session: frames in, input out, and the claim that makes input legal.
 *
 * `controlled` is not a wish — it reflects what the server said when this socket claimed. If the
 * claim was refused because another operator holds the intervention, nothing here can send input.
 */
export function useLiveSession(runId, { by = "operator-1" } = {}) {
  const [frame, setFrame] = useState();
  const [connected, setConnected] = useState(false);
  const [controlled, setControlled] = useState(false);
  const [error, setError] = useState();
  const link = useRef();

  useEffect(() => {
    if (!runId) return;
    let live = true;
    const l = openLiveSocket(runId, {
      open: () => live && setConnected(true),
      // The server tells us on connect whether this session is already under human control, so an
      // operator who claimed over HTTP — or whose socket dropped and came back — gets the cursor
      // rather than a viewport that looks live and swallows every click.
      hello: (m) => live && setControlled(Boolean(m.controlled)),
      close: () => {
        if (!live) return;
        setConnected(false);
        setControlled(false);
      },
      frame: (m) => live && setFrame(m),
      claimed: () => {
        if (!live) return;
        setControlled(true);
        setError(undefined);
      },
      resolved: () => live && setControlled(false),
      error: (m) => live && setError(m.error),
    });
    link.current = l;
    return () => {
      live = false;
      l.close();
      link.current = undefined;
    };
  }, [runId]);

  const claim = useCallback((interventionId) => link.current?.send({ type: "claim", interventionId, by }), [by]);
  const handBack = useCallback(
    (resumeAt, note, interventionId) => link.current?.send({ type: "resolve", interventionId, resumeAt, note, by }),
    [by],
  );
  const send = useCallback((msg) => link.current?.send(msg), []);

  return { frame, connected, controlled, error, claim, handBack, send, clearError: () => setError(undefined) };
}

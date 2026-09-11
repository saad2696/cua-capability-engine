/**
 * The live channel: frames out, input in.
 *
 * This is the half of "escalation" that makes it a handover rather than a ticket. The operator sees
 * the automation's actual browser and clicks in it; every click is hit-tested against the same
 * accessibility tree the agent uses, so a human fix is captured with the same locator fidelity as an
 * agent action and can later be proposed as a patch to the artifact.
 */
import type { Locator } from "@cua/schema";
import { isSensitiveName } from "../surface/playwright/perception.js";
import type { Surface } from "../surface/types.js";
import type { Session } from "../session/Session.js";
import type { LeasedSurface } from "../session/LeasedSurface.js";

export type InputMessage =
  | { type: "mouse"; op: "click" | "move" | "down" | "up"; x: number; y: number }
  | { type: "key"; op: "press"; key: string }
  | { type: "key"; op: "type"; text: string; x?: number; y?: number }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "dialog"; accept: boolean; text?: string }
  | { type: "navigate"; url: string };

export interface FrameMessage {
  type: "frame";
  seq: number;
  url: string;
  /** Who was driving when the frame was taken, so the console can label it without guessing. */
  controller?: string;
  viewport: { width: number; height: number };
  dialog?: { type: string; message: string };
  /** base64 PNG. */
  png: string;
}

/**
 * Whether a frame is worth capturing right now, and how often.
 *
 * Watching the automation work is most of what makes the system legible to a person, so frames flow
 * whenever somebody is attached — including while the engine drives. The rate differs because the
 * purposes differ: an operator who has taken control needs their own clicks to feel immediate,
 * while an observer watching the engine needs only to follow along, and a slower cadence there
 * leaves the browser's connection free for the work itself.
 */
export function shouldStream(session: Session): boolean {
  return session.state !== "idle" && session.state !== "completed" && session.state !== "aborted";
}

export function frameIntervalMs(session: Session): number {
  return session.state === "human_control" ? 300 : session.state === "paused" ? 500 : 450;
}

export class FrameStreamer {
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private busy = false;
  private interval = 0;

  constructor(
    private readonly surface: Surface,
    private readonly session: Session,
    private readonly send: (f: FrameMessage) => void,
  ) {}

  start(): void {
    this.schedule();
  }

  /** Re-armed on every tick, because the right cadence depends on who is driving. */
  private schedule(): void {
    const want = frameIntervalMs(this.session);
    if (this.timer && this.interval === want) return;
    clearInterval(this.timer);
    this.interval = want;
    this.timer = setInterval(() => void this.tick(), want);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    // One capture in flight at a time: a slow frame must not queue up behind itself and starve the
    // operator's own input, which shares the same connection to the browser.
    this.schedule();
    if (this.busy || !shouldStream(this.session)) return;
    this.busy = true;
    try {
      const dialog = this.surface.pendingDialog();
      // A pending dialog blocks screenshots entirely. Say so rather than freezing on a stale frame.
      const png = dialog ? Buffer.alloc(0) : await this.surface.screenshot();
      this.seq += 1;
      this.send({
        type: "frame", seq: this.seq, url: this.surface.frameUrl() ?? "",
        viewport: { width: 1280, height: 800 },
        controller: this.session.controller,
        ...(dialog ? { dialog: { type: dialog.type, message: dialog.message } } : {}),
        png: png.toString("base64"),
      });
    } catch {
      /* a torn-down page just stops producing frames */
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Apply one operator input to the live browser, and record what it was in the same vocabulary the
 * engine uses for its own actions.
 *
 * Coordinates arrive in the screenshot's own pixel space. The surface's boxes are page coordinates
 * and the streamer sends unscaled PNGs, so the two spaces coincide — but the conversion is done in
 * one place on purpose, because every coordinate bug in this project has come from a factor applied
 * twice in two different files.
 */
export async function applyInput(
  msg: InputMessage,
  leased: LeasedSurface,
  session: Session,
  scale = 1,
): Promise<void> {
  const at = new Date().toISOString();
  const pt = (x: number, y: number) => ({ x: Math.round(x / scale), y: Math.round(y / scale) });

  switch (msg.type) {
    case "mouse": {
      const point = pt(msg.x, msg.y);
      if (msg.op !== "click") {
        await leased.act({ kind: "click", target: { point } });
        return;
      }
      // Hit-test before acting: once the click lands the element may be gone.
      const locator = await locatorAtPoint(leased, point);
      const before = await leased.act({ kind: "click", target: { point } });
      session.recordHumanAction({ at, action: "click", ...(locator ? { locator } : {}), url: leased.frameUrl() ?? "" });
      if (!before.ok) session.recordHumanAction({ at, action: `click failed: ${before.error ?? "unknown"}` });
      return;
    }
    case "key": {
      if (msg.op === "press") {
        await leased.act({ kind: "press", key: msg.key });
        session.recordHumanAction({ at, action: `press ${msg.key}` });
        return;
      }
      const point = msg.x !== undefined && msg.y !== undefined ? pt(msg.x, msg.y) : undefined;
      const locator = point ? await locatorAtPoint(leased, point) : undefined;
      await leased.act(point ? { kind: "type", target: { point }, text: msg.text } : { kind: "press", key: msg.text });
      // Redaction here is by *field*, not by value: the operator is typing something the redactor has
      // never seen, so the only safe signal is what it is going into.
      const sensitive = isSensitiveField(locator);
      session.recordHumanAction({ at, action: "type", ...(locator ? { locator } : {}), value: sensitive ? "[redacted]" : msg.text });
      return;
    }
    case "scroll":
      await leased.act({ kind: "scroll", dx: msg.dx, dy: msg.dy });
      return;
    case "dialog":
      await leased.act({ kind: "dismissDialog", accept: msg.accept, ...(msg.text ? { text: msg.text } : {}) });
      session.recordHumanAction({ at, action: `dialog ${msg.accept ? "accept" : "dismiss"}` });
      return;
    case "navigate":
      // A human is trusted to go where the flow would not, but it is recorded as an override rather
      // than passing silently.
      await leased.act({ kind: "navigate", url: msg.url });
      session.recordHumanAction({ at, action: "navigate", value: msg.url });
      return;
  }
}

async function locatorAtPoint(surface: LeasedSurface, point: { x: number; y: number }): Promise<Locator | undefined> {
  try {
    const obs = await surface.observe();
    const hit = obs.elements.find((e) => point.x >= e.bbox[0] && point.x <= e.bbox[0] + e.bbox[2] && point.y >= e.bbox[1] && point.y <= e.bbox[1] + e.bbox[3]);
    if (!hit) return undefined;
    return await surface.captureLocator(hit.index);
  } catch {
    return undefined;
  }
}

function isSensitiveField(locator: Locator | undefined): boolean {
  if (!locator) return true; // unknown field, unknown risk: redact
  return locator.candidates.some((c) => ("name" in c && c.name ? isSensitiveName(c.name) : false) || ("text" in c && c.text ? isSensitiveName(c.text) : false));
}

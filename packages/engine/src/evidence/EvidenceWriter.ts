/**
 * One directory per run: events.jsonl (redacted), screenshots/, and any JSON documents the
 * run produces. The writer is the single exit for run data, so redaction cannot be bypassed.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EventSchema, type Event } from "@cua/schema";
import type { Redactor } from "./redactor.js";

type EventInput = Omit<Event, "seq" | "ts" | "runId">;

export class EvidenceWriter {
  readonly dir: string;
  private seq = 0;
  private screenshotCount = 0;

  constructor(readonly runId: string, baseDir: string, readonly redactor: Redactor, dirName?: string) {
    this.dir = join(baseDir, dirName ?? runId);
    mkdirSync(join(this.dir, "screenshots"), { recursive: true });
  }

  event<E extends EventInput>(e: E): Event {
    const full = { ...e, seq: this.seq, ts: new Date().toISOString(), runId: this.runId } as unknown as Event;
    this.seq += 1;
    const redacted = this.redactor.value(full);
    const parsed = EventSchema.safeParse(redacted);
    if (!parsed.success) throw new Error(`invalid evidence event ${String((e as { type?: string }).type)}: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(parsed.data) + "\n");
    return parsed.data;
  }

  /** Save a PNG; returns the path relative to the run dir (what events reference). */
  screenshot(label: string, png: Buffer): string {
    if (!png.length) return "";
    this.screenshotCount += 1;
    const name = `${String(this.screenshotCount).padStart(3, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.png`;
    writeFileSync(join(this.dir, "screenshots", name), png);
    return join("screenshots", name);
  }

  json(name: string, value: unknown, redact = true): string {
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(redact ? this.redactor.value(value) : value, null, 2) + "\n");
    return path;
  }

  text(name: string, value: string, redact = true): string {
    const path = join(this.dir, name);
    writeFileSync(path, redact ? this.redactor.text(value) : value);
    return path;
  }

  relative(from = process.cwd()): string {
    return relative(from, this.dir);
  }
}

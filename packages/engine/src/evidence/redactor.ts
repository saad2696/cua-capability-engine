/**
 * Redaction: every string that leaves the engine (events, artifacts, prompts stored as
 * evidence) passes through here. Sensitive values are replaced by a labelled placeholder so a
 * reviewer can still follow the flow without seeing the data.
 */
export interface RedactorOptions {
  /** name → value; values are replaced by `[redacted:<name>]` */
  secrets: Record<string, string>;
}

export class Redactor {
  private readonly entries: { name: string; value: string }[];

  constructor(opts: RedactorOptions) {
    this.entries = Object.entries(opts.secrets)
      .filter(([, v]) => typeof v === "string" && v.length >= 2)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value.length - a.value.length); // longest first so substrings do not leak
  }

  text(s: string): string {
    let out = s;
    for (const { name, value } of this.entries) out = out.split(value).join(`[redacted:${name}]`);
    return out;
  }

  /** Deep-redact any JSON-serialisable value. Buffers are left alone (screenshots are files). */
  value<T>(v: T): T {
    if (typeof v === "string") return this.text(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as T;
    if (v && typeof v === "object" && !Buffer.isBuffer(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = this.value(x);
      return out as T;
    }
    return v;
  }

  has(): boolean {
    return this.entries.length > 0;
  }
}

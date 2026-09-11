/**
 * Output extraction on replay: try the declared candidates in order, parse to the declared type,
 * validate. Reports which strategy worked (drift signal when it is not the first).
 */
import type { OutputSpec } from "@cua/schema";
import type { Surface } from "../surface/types.js";
import { normalizeText, parseMoney, parseNumber } from "./text.js";

export interface ExtractionResult {
  ok: boolean;
  raw?: string;
  parsed?: unknown;
  strategy?: string;
  candidateIndex?: number;
  error?: string;
}

export function parseByType(raw: string, spec: OutputSpec): { value: unknown; error?: string } {
  const p = spec.extract.parse;
  switch (p.kind) {
    case "string":
      return { value: p.trim ? normalizeText(raw) : raw };
    case "number": {
      const n = parseNumber(raw);
      return n === null ? { value: undefined, error: `not a number: ${JSON.stringify(raw)}` } : { value: n };
    }
    case "money": {
      const m = parseMoney(raw, p.currency);
      return m ? { value: m } : { value: undefined, error: `not a money amount: ${JSON.stringify(raw)}` };
    }
    case "boolean": {
      const t = normalizeText(raw).toLowerCase();
      return { value: p.truthy.map((x) => x.toLowerCase()).includes(t) };
    }
    case "date": {
      const t = normalizeText(raw);
      return /^\d{4}-\d{2}-\d{2}$/.test(t) || !Number.isNaN(Date.parse(t)) ? { value: t } : { value: undefined, error: `not a date: ${JSON.stringify(raw)}` };
    }
  }
}

export function validateParsed(value: unknown, spec: OutputSpec): string | undefined {
  const v = spec.extract.validate;
  if (!v) return undefined;
  const n = typeof value === "number" ? value : value && typeof value === "object" && "amount" in value ? (value as { amount: number }).amount : undefined;
  if (v.min !== undefined && n !== undefined && n < v.min) return `value ${n} below minimum ${v.min}`;
  if (v.max !== undefined && n !== undefined && n > v.max) return `value ${n} above maximum ${v.max}`;
  if (v.pattern && typeof value === "string" && !new RegExp(v.pattern).test(value)) return `value does not match ${v.pattern}`;
  return undefined;
}

export async function extractOutput(name: string, spec: OutputSpec, surface: Surface, defaultFrame?: string[]): Promise<ExtractionResult> {
  const errors: string[] = [];
  for (let i = 0; i < spec.extract.candidates.length; i += 1) {
    const c = spec.extract.candidates[i]!;
    const raw = await surface.extract(c, defaultFrame);
    if (raw === null || normalizeText(raw) === "") {
      errors.push(`${c.strategy}: nothing found`);
      continue;
    }
    const { value, error } = parseByType(raw, spec);
    if (error) {
      errors.push(`${c.strategy}: ${error}`);
      continue;
    }
    const invalid = validateParsed(value, spec);
    if (invalid) {
      errors.push(`${c.strategy}: ${invalid}`);
      continue;
    }
    return { ok: true, raw, parsed: value, strategy: c.strategy, candidateIndex: i };
  }
  return { ok: false, error: `${name}: ${errors.join("; ") || "no candidates"}` };
}

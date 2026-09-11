/**
 * Text normalisation for detectors and assertions. Legacy screens are full of stray whitespace,
 * NBSPs and inconsistent casing; comparisons must not be.
 */
export function normalizeText(s: string): string {
  // NBSP and friends are written as escapes on purpose: a literal one here is invisible in a
  // diff and indistinguishable from the ordinary space two characters later.
  return s.normalize("NFC").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Build a RegExp from a pattern and optional flags; case-insensitive by default unless flags are given. */
export function toRegExp(pattern: string, flags?: string): RegExp {
  const f = flags ?? "i";
  try {
    return new RegExp(pattern, f.includes("g") ? f.replace("g", "") : f);
  } catch {
    // treat an invalid pattern as a literal
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), f);
  }
}

export function textMatches(haystack: string, pattern: string, flags?: string, exact = false): boolean {
  const h = normalizeText(haystack);
  if (exact) return h === normalizeText(pattern);
  return toRegExp(pattern, flags).test(h);
}

/** Numbers as displayed by US banking UIs: "$1,234.56", "-$12.00", "(12.00)", "1 234,56" (not supported: locale-specific). */
export function parseMoney(raw: string, currency = "USD"): { amount: number; currency: string } | null {
  const s = normalizeText(raw);
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || !/\d/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return { amount: negative ? -n : n, currency };
}

export function parseNumber(raw: string): number | null {
  const s = normalizeText(raw).replace(/[,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

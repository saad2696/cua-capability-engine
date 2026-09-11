import type { Value } from "@cua/schema";

export interface ValueContext {
  params: Record<string, string>;
  secrets: Record<string, string>;
}

/** Resolve a Value to the string the surface should use. Throws for unresolvable references (pre-flight prevents this). */
export function resolveValue(v: Value, ctx: ValueContext): string {
  switch (v.kind) {
    case "literal":
      return v.value;
    case "param": {
      const p = ctx.params[v.name];
      if (p === undefined) throw new Error(`missing parameter ${v.name}`);
      return p;
    }
    case "secret": {
      const s = ctx.secrets[v.name];
      if (s === undefined) throw new Error(`missing secret ${v.name}`);
      return s;
    }
  }
}

/** Redacted rendering for logs: literals verbatim, references by name. */
export function describeValue(v: Value | undefined): string {
  if (!v) return "";
  if (v.kind === "literal") return JSON.stringify(v.value);
  if (v.kind === "param") return `{${v.name}}`;
  return `<secret ${v.name}>`;
}

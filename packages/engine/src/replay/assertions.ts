/**
 * Assertions are the checkpoints: per-step `expect`, screen-signature negatives, and the final
 * `checkpoint`. Each returns a structured verdict so failures carry expected-vs-observed detail.
 */
import type { Assertion, Locator } from "@cua/schema";
import type { Surface } from "../surface/types.js";
import { textMatches, toRegExp } from "./text.js";
import { resolveValue, type ValueContext } from "./values.js";

export interface Verdict {
  ok: boolean;
  expected: string;
  observed: string;
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export async function checkAssertion(a: Assertion, surface: Surface, ctx: ValueContext, target?: Locator, defaultFrame?: string[]): Promise<Verdict> {
  switch (a.kind) {
    case "urlMatches": {
      const url = a.scope === "top" ? surface.frameUrl(undefined) : surface.frameUrl(defaultFrame);
      const path = pathOf(url);
      const ok = toRegExp(a.pattern, a.flags ?? "").test(path) || toRegExp(a.pattern, a.flags ?? "").test(url ?? "");
      return { ok, expected: `url matches ${a.pattern}`, observed: path || "(no url)" };
    }
    case "textVisible": {
      const text = await surface.visibleText(a.frame ?? defaultFrame);
      if (a.value) {
        const v = resolveValue(a.value, ctx);
        return { ok: text.includes(v), expected: `text contains ${a.value.kind === "literal" ? JSON.stringify(v) : `{${a.value.name}}`}`, observed: text.slice(0, 200) };
      }
      return { ok: textMatches(text, a.pattern!, a.flags), expected: `text matches ${a.pattern}`, observed: text.slice(0, 200) };
    }
    case "textNotVisible": {
      const text = await surface.visibleText(a.frame ?? defaultFrame);
      const hit = toRegExp(a.pattern, a.flags).exec(text);
      return { ok: !hit, expected: `no text matching ${a.pattern}`, observed: hit ? `found "${hit[0]}"` : "absent" };
    }
    case "landmarkVisible": {
      const ok = await surface.landmarkVisible(a.landmark.role, a.landmark.name, a.frame ?? defaultFrame, a.landmark.exact ?? false);
      return { ok, expected: `${a.landmark.role} "${a.landmark.name}" visible`, observed: ok ? "visible" : "not found" };
    }
    case "valueEquals": {
      if (!target) return { ok: false, expected: "target with value", observed: "step has no target" };
      const want = resolveValue(a.value, ctx);
      const got = await surface.readValue(target);
      const ok = got !== null && got.trim() === want;
      const label = a.value.kind === "literal" ? JSON.stringify(want) : `{${a.value.name}}`;
      return { ok, expected: `value equals ${label}`, observed: got === null ? "(unreadable)" : a.value.kind === "secret" ? (ok ? "matches" : "differs") : JSON.stringify(got) };
    }
    case "dialogOpen": {
      const d = surface.pendingDialog();
      const open = Boolean(d);
      let ok = open === a.open;
      if (ok && a.open && a.messageMatches && d) ok = toRegExp(a.messageMatches).test(d.message);
      return { ok, expected: a.open ? `dialog open${a.messageMatches ? ` matching ${a.messageMatches}` : ""}` : "no dialog", observed: d ? `${d.type}: "${d.message}"` : "no dialog" };
    }
  }
}

/** Poll an assertion until it holds or the timeout elapses. */
export async function waitForAssertion(a: Assertion, surface: Surface, ctx: ValueContext, timeoutMs: number, target?: Locator, defaultFrame?: string[]): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  let last = await checkAssertion(a, surface, ctx, target, defaultFrame);
  while (!last.ok && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    last = await checkAssertion(a, surface, ctx, target, defaultFrame);
  }
  return last;
}

export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case "urlMatches": return `urlMatches ${a.pattern}`;
    case "textVisible": return a.pattern ? `textVisible ${a.pattern}` : `textVisible {${a.value!.kind === "literal" ? "literal" : a.value!.name}}`;
    case "textNotVisible": return `textNotVisible ${a.pattern}`;
    case "landmarkVisible": return `landmarkVisible ${a.landmark.role} "${a.landmark.name}"`;
    case "valueEquals": return `valueEquals`;
    case "dialogOpen": return a.open ? "dialogOpen" : "noDialog";
  }
}

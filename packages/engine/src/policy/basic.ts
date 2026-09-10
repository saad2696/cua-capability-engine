/**
 * Minimal discovery-time policy used by the agent loop. Slice 009 replaces the internals with
 * the full policy.yaml loader, risk classifier and multi-layer enforcement; the interface stays.
 */
import type { Decision } from "../llm/types.js";
import type { Observation } from "../surface/types.js";

export interface PolicyVerdict {
  allow: boolean;
  risk: "safe" | "risky";
  reason?: string;
}

export interface DiscoveryPolicy {
  allowedOrigins: string[];
  blockedUrlPatterns: RegExp[];
  allowedTools: Set<string>;
  riskyButtonText: RegExp;
  riskyUrlPatterns: RegExp[];
  check(decision: Decision, obs: Observation): PolicyVerdict;
  allowRequest(url: string): boolean;
}

export interface BasicPolicyOptions {
  allowedOrigins: string[];
  blockedUrlPatterns?: string[];
  riskyButtonText?: string[];
  riskyUrlPatterns?: string[];
  allowedTools?: string[];
}

const DEFAULT_RISKY = ["confirm", "submit", "open account", "transfer", "delete", "close account", "approve", "post", "pay"];

export function basicPolicy(opts: BasicPolicyOptions): DiscoveryPolicy {
  const origins = opts.allowedOrigins.map((o) => new URL(o).origin);
  const blocked = (opts.blockedUrlPatterns ?? []).map((p) => new RegExp(p));
  const risky = new RegExp(`^\\s*(${(opts.riskyButtonText ?? DEFAULT_RISKY).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const riskyUrls = (opts.riskyUrlPatterns ?? ["/confirm", "/submit", "/open"]).map((p) => new RegExp(p));
  const tools = new Set(opts.allowedTools ?? ["click", "type", "select", "press", "navigate", "extract", "assert_state", "done", "give_up"]);

  const allowRequest = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.protocol === "about:" || u.protocol === "data:") return true;
      if (!origins.includes(u.origin)) return false;
      return !blocked.some((re) => re.test(u.pathname));
    } catch {
      return false;
    }
  };

  return {
    allowedOrigins: origins,
    blockedUrlPatterns: blocked,
    allowedTools: tools,
    riskyButtonText: risky,
    riskyUrlPatterns: riskyUrls,
    allowRequest,
    check(decision, obs) {
      if (!tools.has(decision.tool)) return { allow: false, risk: "safe", reason: `tool ${decision.tool} is not permitted` };
      if (decision.tool === "navigate") {
        const url = String(decision.args["url"] ?? "");
        if (!allowRequest(url)) return { allow: false, risk: "safe", reason: `navigation to ${url} is outside the allowlist` };
      }
      if (decision.tool === "click" || decision.tool === "press") {
        let riskyHit = false;
        if (decision.tool === "click") {
          const el = obs.elements[Number(decision.args["index"])];
          if (el && (el.role === "button" || el.role === "link" || el.role === "menuitem") && risky.test(el.name)) riskyHit = true;
        } else if (String(decision.args["key"]).toLowerCase() === "enter") {
          // Enter with focus in a form field submits the form
          const focused = obs.elements.find((e) => e.focused);
          if (focused && (focused.role === "textbox" || focused.role === "combobox")) riskyHit = riskyUrls.some((re) => re.test(obs.frames.map((f) => f.url).join(" ")));
        }
        if (riskyHit) return { allow: true, risk: "risky", reason: "irreversible action requires human approval" };
      }
      return { allow: true, risk: "safe" };
    },
  };
}

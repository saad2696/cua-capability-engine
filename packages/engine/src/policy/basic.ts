/**
 * The decision-time gate (enforcement layer 1 of 4).
 *
 * The `DiscoveryPolicy` interface is unchanged from slice 005 — `loop.ts` and three test files call
 * it and none of them needed editing — but the internals now derive entirely from a validated
 * `Policy` document instead of inline literals. `policyGate()` builds a gate from a whole policy and
 * is what `runPolicy()` uses; `basicPolicy()` is the literals-only shortcut kept for tests.
 *
 * This layer can be bypassed by anything that does not route through the model loop, which is why
 * it is not the only layer: `PolicyEnforcedSurface` re-checks at the boundary where actions become
 * real, and Playwright request interception re-checks at the network.
 */
import type { Decision } from "../llm/types.js";
import type { Observation } from "../surface/types.js";
import { riskClassifier, type RiskClassifier, type RiskSubject } from "./risk.js";
import { DEFAULT_POLICY, type Policy } from "./schema.js";

export interface PolicyVerdict {
  allow: boolean;
  risk: "safe" | "risky";
  reason?: string;
  /** Aligned with the artifact's `sideEffects` vocabulary; absent means "none". */
  sideEffect?: "none" | "possible" | "committed";
}

export interface DiscoveryPolicy {
  allowedOrigins: string[];
  blockedUrlPatterns: RegExp[];
  allowedTools: Set<string>;
  riskyButtonText: RegExp;
  riskyUrlPatterns: RegExp[];
  check(decision: Decision, obs: Observation): PolicyVerdict;
  allowRequest(url: string): boolean;
  /** The document every rule above was derived from. */
  readonly policy: Policy;
  readonly classifier: RiskClassifier;
}

export interface BasicPolicyOptions {
  allowedOrigins: string[];
  blockedUrlPatterns?: string[];
  riskyButtonText?: string[];
  riskyUrlPatterns?: string[];
  allowedTools?: string[];
}

/** Build a gate from a full policy document. */
export function policyGate(policy: Policy): DiscoveryPolicy {
  const origins = policy.allowedOrigins.map((o) => new URL(o).origin);
  const blocked = policy.blockedUrlPatterns.map((p) => new RegExp(p, "i"));
  const tools = new Set(policy.allowedActions);
  const classifier = riskClassifier(policy.risk);

  const allowRequest = (url: string): boolean => {
    try {
      const u = new URL(url);
      // about:blank and data: are the browser's own scratch surfaces, never a network egress.
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
    riskyButtonText: classifier.buttonText,
    riskyUrlPatterns: classifier.urlPatterns,
    allowRequest,
    policy,
    classifier,
    check(decision, obs) {
      if (!tools.has(decision.tool)) return { allow: false, risk: "safe", reason: `tool ${decision.tool} is not permitted` };
      if (decision.tool === "navigate") {
        const url = String(decision.args["url"] ?? "");
        if (!allowRequest(url)) return { allow: false, risk: "safe", reason: `navigation to ${url} is outside the allowlist` };
      }

      const el = decision.tool === "click" ? obs.elements[Number(decision.args["index"])] : undefined;
      const focused = obs.elements.find((e) => e.focused);
      const subject: RiskSubject = {
        action: decision.tool,
        pageUrl: obs.url,
        ...(el ? { targetName: el.name, targetRole: el.role } : {}),
        ...(decision.tool === "navigate" ? { url: String(decision.args["url"] ?? "") } : {}),
        ...(decision.tool === "press" ? { key: String(decision.args["key"] ?? "") } : {}),
        ...(focused && (focused.role === "textbox" || focused.role === "combobox") ? { focusInForm: true } : {}),
        ...(decision.tool === "dismiss_dialog" ? { accept: decision.args["accept"] === true, dialogMessage: obs.dialog?.message ?? "" } : {}),
        ...(decision.args["irreversible"] === true ? { modelFlagged: true } : {}),
      };
      const verdict = classifier.classify(subject);
      if (verdict.risk === "risky") {
        const why = verdict.reasons.join("; ");
        if (policy.discovery.onRisky === "block") return { allow: false, risk: "risky", reason: `irreversible action refused by policy: ${why}`, sideEffect: verdict.sideEffect };
        return { allow: true, risk: "risky", reason: `irreversible action requires human approval — ${why}`, sideEffect: verdict.sideEffect };
      }
      return { allow: true, risk: "safe", sideEffect: verdict.sideEffect };
    },
  };
}

/**
 * Convenience constructor: start from the defaults and override only the fields a caller names.
 * Every production entry point goes through `runPolicy()` in load.js instead, so that `policy.yaml`
 * is what governs a run; this remains for tests, which need a gate built from literals without a
 * file on disk, and it is the baseline those tests compare an edited policy against.
 */
export function basicPolicy(opts: BasicPolicyOptions): DiscoveryPolicy {
  const d = DEFAULT_POLICY;
  return policyGate({
    ...d,
    allowedOrigins: opts.allowedOrigins.length ? opts.allowedOrigins : d.allowedOrigins,
    blockedUrlPatterns: opts.blockedUrlPatterns ?? d.blockedUrlPatterns,
    allowedActions: opts.allowedTools ?? d.allowedActions,
    risk: {
      ...d.risk,
      irreversibleButtonText: opts.riskyButtonText ?? d.risk.irreversibleButtonText,
      irreversibleUrlPatterns: opts.riskyUrlPatterns ?? d.risk.irreversibleUrlPatterns,
    },
  });
}

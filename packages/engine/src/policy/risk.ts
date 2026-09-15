/**
 * Risk classification: does this action commit something a human cannot take back?
 *
 * Deliberately pure and deliberately boring. Both callers — the discovery loop, which has a model
 * `Decision` plus an `Observation`, and the surface boundary, which has a `SurfaceAction` plus the
 * element it resolved to — flatten what they know into a `RiskSubject` and get the same answer. A
 * rule that lived in one of those two call paths would apply to one of them only, which is the
 * failure mode this module exists to prevent.
 *
 * Two grades, not one. The design called for a single `risky` flag with `formSubmitIsRisky: true`,
 * which would have flagged every POST in the sub-account flow — including the validation step that
 * only re-renders the form. Escalating twice for one irreversible act trains an operator to click
 * through prompts, which is the opposite of what the gate is for. So a form submit that matches no
 * irreversible signal reports `sideEffect: "possible"` and runs; a submit whose button text or
 * target URL matches reports `risky` + `committed` and stops for a human.
 *
 * The grade borrows `ReplayResult.sideEffects`'s vocabulary deliberately, but note what it is: a
 * prediction about an action not yet taken, where the result field is a record of what a finished
 * run did. Nothing couples them mechanically — the artifact carries `pointOfNoReturn`, which the
 * executor turns into `possible` and then `committed` as a step succeeds. Sharing the words means an
 * operator learns one set; it is not a guarantee that the prediction and the record agree.
 * See docs/adr/0002-graded-risk-classification.md.
 */
import type { RiskPolicy } from "./schema.js";

export interface RiskSubject {
  /** click | type | select | press | navigate | scroll | dismissDialog */
  action: string;
  /** Accessible name or visible text of the control being acted on. */
  targetName?: string;
  /** Accessible role of that control. */
  targetRole?: string;
  /** The control submits a form (`<button type=submit>`, `<input type=submit>`). */
  isSubmit?: boolean;
  /** The `action` attribute of the form the control belongs to, absolute or relative. */
  formAction?: string;
  /** For `navigate`: where it is going. */
  url?: string;
  /** The URL of the page the action happens on, used to resolve a relative form action. */
  pageUrl?: string;
  /** For `press`: which key. */
  key?: string;
  /** Focus is currently inside a form field. */
  focusInForm?: boolean;
  /** The model itself declared the step irreversible; always honoured. */
  modelFlagged?: boolean;
  /** For `dismiss_dialog`: true accepts the dialog, false cancels it. */
  accept?: boolean;
  /** The text of the dialog being answered, for the operator's benefit. */
  dialogMessage?: string;
}

export interface RiskVerdict {
  risk: "safe" | "risky";
  /** Aligned with the artifact's `sideEffects` vocabulary. */
  sideEffect: "none" | "possible" | "committed";
  /** Every rule that fired, in the order checked. Surfaced to the operator, so plain English. */
  reasons: string[];
}

/** Word-boundary match anywhere in the name, so "Open Account" is caught inside "Confirm — Open Account". */
export function buildButtonTextMatcher(terms: string[]): RegExp {
  const escaped = terms.map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

const compileAll = (patterns: string[]): RegExp[] => patterns.map((p) => new RegExp(p, "i"));

/** Resolve a possibly-relative form action against the page it was rendered on. */
function absolutise(target: string | undefined, pageUrl: string | undefined): string | undefined {
  if (!target) return undefined;
  if (!pageUrl) return target;
  try {
    return new URL(target, pageUrl).toString();
  } catch {
    return target;
  }
}

export interface RiskClassifier {
  classify(subject: RiskSubject): RiskVerdict;
  /** Exposed for the legacy `DiscoveryPolicy` surface and for diagnostics. */
  readonly buttonText: RegExp;
  readonly urlPatterns: RegExp[];
}

export function riskClassifier(policy: RiskPolicy): RiskClassifier {
  const buttonText = buildButtonTextMatcher(policy.irreversibleButtonText);
  const urlPatterns = compileAll(policy.irreversibleUrlPatterns);
  const urlHit = (u: string | undefined): boolean => (u ? urlPatterns.some((re) => re.test(u)) : false);

  return {
    buttonText,
    urlPatterns,
    classify(s: RiskSubject): RiskVerdict {
      const reasons: string[] = [];
      // Reading and scrolling cannot commit anything, whatever they are pointed at.
      if (s.action === "extract" || s.action === "assert_state" || s.action === "scroll" || s.action === "observe")
        return { risk: "safe", sideEffect: "none", reasons };

      if (s.modelFlagged) reasons.push("the model declared this step irreversible");

      // Answering a dialog. Cancelling is always safe — it is how an agent backs out. Accepting is
      // not: a legacy UI raises `confirm()` precisely at the point it will not let you back out of,
      // so the accept *is* the commit. It escalates even when the click that raised the dialog was
      // already approved, because the application's own last-chance prompt is the one a banking
      // operator expects to be shown, and an approval given before that text appeared did not cover
      // it. See docs/adr/0006-accepting-a-dialog-is-its-own-decision.md.
      if (s.action === "dismiss_dialog" || s.action === "dismissDialog") {
        if (s.accept !== true) return { risk: "safe", sideEffect: "none", reasons: ["cancelling a dialog"] };
        reasons.push(`it accepts the dialog "${(s.dialogMessage ?? "").trim()}"`);
      }

      const actionable = s.action === "click" || s.action === "press" || s.action === "navigate";
      const isControl = s.targetRole === undefined || ["button", "link", "menuitem", "tab", ""].includes(s.targetRole);
      if (actionable && isControl && s.targetName && buttonText.test(s.targetName))
        reasons.push(`the control is labelled "${s.targetName.trim()}"`);

      const destination = s.action === "navigate" ? s.url : absolutise(s.formAction, s.pageUrl);
      if (urlHit(destination)) reasons.push(`it targets ${destination}`);

      // Enter in a text field submits the surrounding form in almost every legacy UI, and the engine
      // cannot see which form without resolving it, so `destination` above had nothing to work with.
      // Fall back to the page's own URL — but only here. Applying that fallback to clicks would
      // misfire on the page *after* a commit: /member/:id/subaccount/open matches the irreversible
      // list, so "Return to Member" on the confirmation screen would read as a second commit.
      const enterSubmits =
        policy.keyboardEnterOnFormIsRisky && s.action === "press" && String(s.key ?? "").toLowerCase() === "enter" && s.focusInForm === true;
      if (enterSubmits && urlHit(s.pageUrl)) reasons.push(`Enter submits a form on ${s.pageUrl}`);

      if (reasons.length) return { risk: "risky", sideEffect: "committed", reasons };

      // No irreversible signal, but something is being posted: real but not proven irreversible.
      if (policy.formSubmitIsRisky && (s.isSubmit === true || enterSubmits))
        return { risk: "safe", sideEffect: "possible", reasons: ["it submits a form, but no irreversible signal matched"] };

      return { risk: "safe", sideEffect: "none", reasons };
    },
  };
}

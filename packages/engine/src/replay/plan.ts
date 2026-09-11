/**
 * Plan mode: describe what a replay would do without opening a browser. Reviewers and callers use
 * it to inspect the step plan, risk flags, and points of no return.
 */
import { isRetryable, type Capability, type Step } from "@cua/schema";
import { describeAssertion } from "./assertions.js";
import { describeSignature } from "./signature.js";
import { describeValue } from "./values.js";

function targetOf(s: Step): string {
  const c = s.target?.candidates[0];
  if (!c) return "";
  if (c.strategy === "role") return `${c.role} "${c.name}"`;
  if (c.strategy === "label" || c.strategy === "text" || c.strategy === "placeholder") return `"${c.text}"`;
  if (c.strategy === "css") return c.selector;
  return `visual@${c.bbox.join(",")}`;
}

export function planLines(cap: Capability): string[] {
  const out: string[] = [];
  out.push(`${cap.capability.name} [${cap.capability.id}@${cap.capability.version}, ${cap.capability.status}]`);
  out.push(`inputs: ${Object.entries(cap.inputs).map(([k, v]) => `${k}:${v.type}${v.required ? "" : "?"}`).join(", ") || "none"}   outputs: ${Object.entries(cap.outputs).map(([k, v]) => `${k}:${v.type}`).join(", ") || "none"}`);
  out.push(`secrets: ${cap.requires.secrets.join(", ") || "none"}   origins: ${cap.policy.allowedOrigins.join(", ")}`);
  const line = (s: Step, prefix: string) => {
    const flags = [s.risk === "risky" ? "RISKY" : "", s.pointOfNoReturn ? "POINT-OF-NO-RETURN" : "", s.optional ? "optional" : "", isRetryable(s) ? "retryable" : "single-attempt"].filter(Boolean).join(", ");
    out.push(`${prefix} ${s.action} ${targetOf(s)} ${describeValue(s.value)}  [${flags}]`);
    out.push(`      intent: ${s.intent}`);
    if (s.precondition) out.push(`      precondition: ${describeSignature(s.precondition)}`);
    if (s.expect.length) out.push(`      expect: ${s.expect.map(describeAssertion).join("; ")}`);
    if (s.target && s.target.candidates.length > 1) out.push(`      fallbacks: ${s.target.candidates.slice(1).map((c) => c.strategy).join(" → ")}`);
  };
  for (const [name, steps] of Object.entries(cap.preludes)) {
    out.push(`prelude ${name}:`);
    steps.forEach((s, i) => line(s, `  ${name}.${i + 1}`));
  }
  out.push("steps:");
  cap.steps.forEach((s, i) => line(s, `  ${i + 1}.`));
  out.push(`checkpoint: ${cap.checkpoint.map(describeAssertion).join("; ")}`);
  out.push(`outcomes: ${cap.outcomes.map((o) => `${o.code}(${o.kind}${o.recover ? `→${o.recover}` : ""}${o.escalate ? ",escalate" : ""})`).join(", ") || "none"}`);
  return out;
}

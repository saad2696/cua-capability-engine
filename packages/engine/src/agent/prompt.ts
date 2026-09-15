/**
 * Prompt construction. The system prompt is frozen (cacheable). Each turn is a single user
 * message rebuilt from scratch: goal, parameters, compact history, notices, the numbered element
 * list, and the marked screenshot. We do not accumulate tool_use/tool_result pairs, so the token
 * budget per turn is bounded regardless of run length.
 */
import type { DecisionContext, HistoryEntry } from "../llm/types.js";

export const VERBATIM_HISTORY = 3;

export function systemPrompt(): string {
  return `You are the discovery agent of a computer-use automation system for back-office banking applications.
You operate a legacy web application the way a careful human operator would, one action per turn, to accomplish a stated goal.
Your successful run will be recorded as a deterministic, replayable capability, so prefer the simplest direct path.

Each turn you receive: the goal, named parameters, what you did so far, a numbered list of the interactive controls on screen, and a screenshot where each control carries its number. You must respond with exactly one tool call.

Rules:
- Act only through the tools. Refer to controls by their number.
- To enter a parameter or secret, type its placeholder such as {memberId} or {TARGET_PASSWORD}; never type a secret's real value and never invent values.
- Read values from the screen with the extract tool, giving the exact displayed text and where it sits (row label, column header, or adjacent label).
- Before any irreversible action (Confirm, Submit, Open account, Transfer, Delete, Approve), call assert_state with kind needs_human_confirmation instead of clicking. A human decides.
- If the screen shows an error, a not-found message, or a validation problem, call assert_state with kind error_seen before deciding what to do next.
- Stay within the allowed origins. Do not open other sites.
- When the goal is fully achieved and all requested values are extracted, call done. If you cannot proceed safely, call give_up with the reason.
- Be economical: do not click around to explore when the path is clear.`;
}

export function historyText(history: HistoryEntry[]): string {
  if (!history.length) return "(no actions yet)";
  const older = history.slice(0, Math.max(0, history.length - VERBATIM_HISTORY));
  const recent = history.slice(-VERBATIM_HISTORY);
  const lines: string[] = [];
  if (older.length) lines.push(`Earlier (${older.length} steps): ` + older.map((h) => `${h.step}:${h.tool}${h.outcome !== "ok" ? `(${h.outcome})` : ""}`).join(", "));
  for (const h of recent) lines.push(`${h.step}. ${h.summary}${h.outcome !== "ok" ? ` — ${h.outcome}${h.note ? `: ${h.note}` : ""}` : ""}`);
  return lines.join("\n");
}

export function elementsText(ctx: DecisionContext): string {
  const { observation: obs } = ctx;
  if (!obs.elements.length) return "(no interactive controls detected)";
  return obs.elements
    .map((e) => {
      const frame = e.frame.length ? ` frame=${e.frame.join("/")}` : "";
      const value = e.value !== undefined && e.value !== "" ? ` value="${e.value}"` : "";
      const state = !e.enabled ? " disabled" : "";
      return `[${e.index}] ${e.role} "${e.name}"${value}${state}${frame}`;
    })
    .join("\n");
}

export function userText(ctx: DecisionContext): string {
  const obs = ctx.observation;
  const params = Object.keys(ctx.params).length ? Object.entries(ctx.params).map(([k, v]) => `  {${k}} = ${v}`).join("\n") : "  (none)";
  const secrets = ctx.secretNames.length ? ctx.secretNames.map((s) => `  {${s}}`).join("\n") : "  (none)";
  const frames = obs.frames.filter((f) => f.path.length).map((f) => `  ${f.path.join("/")}: ${f.url}`).join("\n");
  const dialog = obs.dialog
    ? `\nA native ${obs.dialog.type} dialog is OPEN: "${obs.dialog.message}". Nothing else on the page can be interacted with until it is answered. If it is the expected consequence of the step you just took, answer it with dismiss_dialog. If it is unexpected, cancel it with dismiss_dialog(accept: false) and record it with assert_state(error_seen).\n`
    : "";
  const notices = ctx.notices.length ? `\nNotices:\n${ctx.notices.map((n) => `  - ${n}`).join("\n")}\n` : "";
  return `Goal: ${ctx.goal}

Parameters (type the placeholder, the engine substitutes the value):
${params}
Secrets available by placeholder only:
${secrets}

Allowed origins: ${ctx.allowedOrigins.join(", ")}
Step ${ctx.stepIndex + 1} of at most ${ctx.maxSteps}.

History:
${historyText(ctx.history)}
${notices}
Current page: ${obs.title || "(untitled)"} — ${obs.url}${frames ? `\nFrames:\n${frames}` : ""}${dialog}
Interactive controls (numbers match the screenshot):
${elementsText(ctx)}

Respond with exactly one tool call.`;
}

import type { Observation } from "../surface/types.js";

/** Tools the model can call. One call per turn. */
export type ToolName = "click" | "type" | "select" | "press" | "navigate" | "extract" | "assert_state" | "dismiss_dialog" | "done" | "give_up";

export interface HistoryEntry {
  step: number;
  tool: ToolName;
  /** One-line, redacted description, e.g. `type [3] textbox "Member ID" ← {memberId}` */
  summary: string;
  outcome: "ok" | "failed" | "blocked";
  note?: string;
}

export interface DecisionContext {
  goal: string;
  /** Parameter names and their current values. Values are needed so the model can type them. */
  params: Record<string, string>;
  /** Secret names the model may type by reference, e.g. {TARGET_USER}. Values never reach the model. */
  secretNames: string[];
  observation: Observation;
  history: HistoryEntry[];
  stepIndex: number;
  maxSteps: number;
  allowedOrigins: string[];
  /** Feedback for this turn: a blocked action, a failed action, a dialog, ... */
  notices: string[];
}

export interface Decision {
  tool: ToolName;
  args: Record<string, unknown>;
  reasoning: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  decide(ctx: DecisionContext): Promise<Decision>;
}

export class ProviderError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "ProviderError";
  }
}

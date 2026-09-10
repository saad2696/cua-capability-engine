import type { Decision, DecisionContext, LlmProvider } from "./types.js";

/**
 * Scripted provider for tests and offline demos. Each script entry is a function of the
 * context so it can look elements up by role/name instead of hard-coding indexes.
 */
export type ScriptStep = (ctx: DecisionContext, helpers: FakeHelpers) => Decision | Omit<Decision, "reasoning">;

export interface FakeHelpers {
  /** Index of the first element matching role and (exact) name; throws if absent. */
  el(role: string, name: string): number;
  has(role: string, name: string): boolean;
  visible(): string[];
}

export class FakeProvider implements LlmProvider {
  readonly name = "fake";
  readonly model = "scripted";
  private cursor = 0;

  constructor(private readonly script: ScriptStep[], private readonly onExhausted: "give_up" | "repeat_last" = "give_up") {}

  async decide(ctx: DecisionContext): Promise<Decision> {
    const helpers: FakeHelpers = {
      el: (role, name) => {
        const e = ctx.observation.elements.find((x) => x.role === role && x.name === name);
        if (!e) throw new Error(`fake script: no ${role} "${name}" on screen; visible: ${helpers.visible().join(", ")}`);
        return e.index;
      },
      has: (role, name) => ctx.observation.elements.some((x) => x.role === role && x.name === name),
      visible: () => ctx.observation.elements.map((x) => `${x.role} "${x.name}"`),
    };
    let step = this.script[this.cursor];
    if (!step) {
      if (this.onExhausted === "repeat_last" && this.script.length) step = this.script[this.script.length - 1]!;
      else return { tool: "give_up", args: { reason: "script exhausted" }, reasoning: "script exhausted", usage: { inputTokens: 0, outputTokens: 0 } };
    }
    this.cursor += 1;
    const d = step(ctx, helpers);
    return { reasoning: "scripted", ...d, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

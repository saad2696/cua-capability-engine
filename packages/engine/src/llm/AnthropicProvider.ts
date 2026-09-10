import Anthropic from "@anthropic-ai/sdk";
import { systemPrompt, userText } from "../agent/prompt.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "./tools.js";
import { ProviderError, type Decision, type DecisionContext, type LlmProvider, type ToolName } from "./types.js";

export interface AnthropicProviderOptions {
  model?: string;
  apiKey?: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

/** USD per million tokens, for the usage report. */
export const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: "low" | "medium" | "high";
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? process.env["CUA_MODEL"] ?? "claude-sonnet-5";
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), timeout: opts.timeoutMs ?? 120_000, maxRetries: 2 });
    this.effort = opts.effort ?? "medium";
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async decide(ctx: DecisionContext): Promise<Decision> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (ctx.observation.screenshotPng.length) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: ctx.observation.screenshotPng.toString("base64") } });
    }
    content.push({ type: "text", text: userText(ctx) });

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        tools: TOOL_DEFINITIONS as Anthropic.Tool[],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort: this.effort },
        messages: [{ role: "user", content }],
      });
    } catch (e) {
      throw new ProviderError(`anthropic request failed: ${(e as Error).message}`, e);
    }

    const usage = {
      inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens ? { cacheReadTokens: response.usage.cache_read_input_tokens } : {}),
    };
    if (response.stop_reason === "refusal") throw new ProviderError("model refused the request");
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    const tool = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tool) {
      // No tool call: treat as a give-up with the model's text so the run stops cleanly.
      return { tool: "give_up", args: { reason: text || `no tool call (stop_reason ${response.stop_reason})` }, reasoning: text, usage };
    }
    if (!TOOL_NAMES.has(tool.name)) throw new ProviderError(`unknown tool ${tool.name}`);
    const { reasoning, ...args } = tool.input as Record<string, unknown> & { reasoning?: string };
    return { tool: tool.name as ToolName, args, reasoning: [text, reasoning].filter(Boolean).join(" ").trim(), usage };
  }
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const p = PRICE_PER_MTOK[model];
  if (!p) return undefined;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

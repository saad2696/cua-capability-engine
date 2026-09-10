/**
 * Provider-neutral tool definitions (JSON Schema). The Anthropic provider passes them through
 * unchanged; a different provider would translate them.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const index = { type: "integer", minimum: 0, description: "Element number from the numbered list / marked screenshot." };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "click",
    description: "Click an interactive element by its number.",
    input_schema: { type: "object", properties: { index, reasoning: { type: "string" } }, required: ["index", "reasoning"], additionalProperties: false },
  },
  {
    name: "type",
    description:
      "Replace the contents of a text field with text. To enter a parameter or secret, pass its placeholder exactly, e.g. \"{memberId}\" or \"{TARGET_PASSWORD}\"; the engine substitutes the real value and never shows secrets to you.",
    input_schema: {
      type: "object",
      properties: { index, text: { type: "string" }, reasoning: { type: "string" } },
      required: ["index", "text", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a dropdown by its visible label.",
    input_schema: { type: "object", properties: { index, option: { type: "string" }, reasoning: { type: "string" } }, required: ["index", "option", "reasoning"], additionalProperties: false },
  },
  {
    name: "press",
    description: "Press a keyboard key (e.g. Enter, Tab, Escape).",
    input_schema: { type: "object", properties: { key: { type: "string" }, reasoning: { type: "string" } }, required: ["key", "reasoning"], additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Go to a URL within the allowed origins.",
    input_schema: { type: "object", properties: { url: { type: "string" }, reasoning: { type: "string" } }, required: ["url", "reasoning"], additionalProperties: false },
  },
  {
    name: "extract",
    description:
      "Record a value you can read on the current screen as a named output. Give the exact text as displayed and, when it sits in a table or next to a label, say where: the row label, the column header, or the adjacent label. The engine turns this into a deterministic re-read for replay.",
    input_schema: {
      type: "object",
      properties: {
        output: { type: "string", description: "camelCase output name, e.g. savingsBalance" },
        value: { type: "string", description: "The exact text as displayed, e.g. $1,234.56" },
        description: { type: "string", description: "What this value means to the caller." },
        rowLabel: { type: "string", description: "Text that identifies the table row containing the value." },
        columnHeader: { type: "string", description: "Header of the column containing the value." },
        nearLabel: { type: "string", description: "Label cell immediately left of the value." },
        reasoning: { type: "string" },
      },
      required: ["output", "value", "description", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "assert_state",
    description:
      "Report something about the current screen without acting: goal_screen_reached, error_seen (an error/validation/not-found message is displayed), needs_human_confirmation (the next step is irreversible, e.g. a Confirm/Submit/Transfer button, and a human must approve).",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["goal_screen_reached", "error_seen", "needs_human_confirmation"] }, detail: { type: "string" }, reasoning: { type: "string" } },
      required: ["kind", "detail", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description: "The goal is fully achieved and every requested value has been recorded with extract. Summarize what was done.",
    input_schema: { type: "object", properties: { summary: { type: "string" }, reasoning: { type: "string" } }, required: ["summary", "reasoning"], additionalProperties: false },
  },
  {
    name: "give_up",
    description: "You cannot make progress safely. Explain why so a human can take over.",
    input_schema: { type: "object", properties: { reason: { type: "string" }, reasoning: { type: "string" } }, required: ["reason", "reasoning"], additionalProperties: false },
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

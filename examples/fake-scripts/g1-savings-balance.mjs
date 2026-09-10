/**
 * Scripted "model" for goal G1, used with:
 *   pnpm cua discover --provider fake --fake-script examples/fake-scripts/g1-savings-balance.mjs \
 *     --goal "Look up member {memberId} and read the current savings balance" \
 *     --url http://localhost:4100/ --capability-id member-savings-balance --param memberId=10042
 * Runs the whole pipeline (surface, loop, recorder, evidence) with no API key.
 */
export const script = [
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "User Name"), text: "{TARGET_USER}" }, reasoning: "Enter the operator user name" }),
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Password"), text: "{TARGET_PASSWORD}" }, reasoning: "Enter the operator password" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Sign In") }, reasoning: "Submit the sign-in form" }),
  (_c, h) => ({ tool: "type", args: { index: h.el("textbox", "Member ID"), text: "{memberId}" }, reasoning: "Enter the member id into the search box" }),
  (_c, h) => ({ tool: "click", args: { index: h.el("button", "Search") }, reasoning: "Run the member search" }),
  () => ({ tool: "extract", args: { output: "savingsBalance", value: "$1,234.56", description: "Current balance of the member's Savings account", rowLabel: "Savings", columnHeader: "Current Balance" }, reasoning: "Read the Savings row's Current Balance cell" }),
  () => ({ tool: "done", args: { summary: "Found the member and read the savings balance" }, reasoning: "Goal achieved" }),
];

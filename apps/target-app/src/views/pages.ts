import type { Account, Member } from "../data/members.js";
import { formatMoney } from "../data/members.js";
import { esc, fieldRow, jsLink, page, select, submitButton, textInput, type PageOpts } from "./layout.js";
import { FAULTS } from "../faults.js";

export function loginPage(opts: PageOpts & { error?: string }): string {
  return page("Sign In", `
<form method="post" action="/login" target="_top">
<table class="box" cellpadding="0" cellspacing="0" width="360">
  <tr><td class="hdr" colspan="2">Operator Sign In</td></tr>
  ${opts.error ? `<tr><td colspan="2" class="c2 err">${esc(opts.error)}</td></tr>` : ""}
  ${fieldRow("User Name", textInput("u", "User Name"))}
  ${fieldRow("Password", `<input type="password" name="p" title="Password" size="24">`)}
  <tr><td class="c2" colspan="2" align="right">${submitButton("Sign In")}</td></tr>
</table>
</form>`, opts);
}

export function searchPage(opts: PageOpts & { query?: string; message?: string }): string {
  return page("Member Search", `
<form method="get" action="/search">
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr" colspan="2">Member Search</td></tr>
  ${fieldRow("Member ID", textInput("q", "Member ID", opts.query ?? ""))}
  <tr><td class="c2" colspan="2" align="right">${submitButton("Search")} &nbsp; ${jsLink("Clear", "/search")}</td></tr>
</table>
</form>
${opts.message ? `<p class="err">${esc(opts.message)}</p>` : ""}
<p>Enter the five-digit member number and press Search.</p>`, opts);
}

export function memberPage(opts: PageOpts & { member: Member }): string {
  const m = opts.member;
  const rows = m.accounts
    .map(
      (a) => `<tr class="row">
        <td class="c2">${esc(a.id)}</td><td class="c2">${esc(a.type)}</td><td class="c2">${esc(a.nickname)}</td>
        <td class="c2" align="right">${esc(formatMoney(a.balanceCents))}</td><td class="c2">${esc(a.opened)}</td></tr>`,
    )
    .join("");
  // Real core banking screens foot their ledgers, and an automation that has to add up rows itself
  // cannot be verified: every value a capability returns is re-read from the page on replay, so a
  // number that exists only in the model's head has nowhere to be read back from. Putting the
  // subtotals on the screen is what makes "the total savings" a capability rather than a guess.
  // Deliberately not colspan'd: the table-cell strategy addresses a column by index, and a merged
  // cell would shift the balance out from under the "Current Balance" header.
  const sum = (of?: Account["type"]) => m.accounts.filter((a) => !of || a.type === of).reduce((t, a) => t + a.balanceCents, 0);
  const totalRow = (label: string, cents: number) =>
    `<tr class="row"><td class="c2"></td><td class="c2"></td><td class="c2"><b>${esc(label)}</b></td>
      <td class="c2" align="right"><b>${esc(formatMoney(cents))}</b></td><td class="c2"></td></tr>`;
  const totals = [
    ...(m.accounts.some((a) => a.type === "Checking") ? [totalRow("Total checking", sum("Checking"))] : []),
    ...(m.accounts.some((a) => a.type === "Savings") ? [totalRow("Total savings", sum("Savings"))] : []),
    totalRow("Total balance", sum()),
  ].join("");

  return page("Member Detail", `
<table class="box" cellpadding="0" cellspacing="0" width="640">
  <tr><td class="hdr" colspan="4">Member Detail</td></tr>
  <tr class="row"><td class="c1">Member ID</td><td class="c2">${esc(m.id)}</td><td class="c1">Status</td><td class="c2">${esc(m.status)}</td></tr>
  <tr class="row"><td class="c1">Name</td><td class="c2">${esc(m.firstName)} ${esc(m.lastName)}</td><td class="c1">Branch</td><td class="c2">${esc(m.branch)}</td></tr>
  <tr class="row"><td class="c1">Member Since</td><td class="c2">${esc(m.since)}</td><td class="c1">Accounts</td><td class="c2">${m.accounts.length}</td></tr>
</table>
<br>
<table class="box" cellpadding="0" cellspacing="0" width="640">
  <tr><td class="hdr" colspan="5">Accounts</td></tr>
  <tr><td class="c1">Account</td><td class="c1">Type</td><td class="c1">Nickname</td><td class="c1" align="right">Current Balance</td><td class="c1">Opened</td></tr>
  ${rows}
  ${totals}
</table>
<br>
<table cellpadding="0" cellspacing="0"><tr>
  <td class="c2">${jsLink("Open New Sub-Account", `/member/${m.id}/subaccount/new`)}</td>
  <td class="c2">${jsLink("Back to Search", "/search")}</td>
</tr></table>`, opts);
}

export interface SubAccountForm {
  type: string;
  nickname: string;
  deposit: string;
  source: string;
}

export function subAccountFormPage(opts: PageOpts & { member: Member; form: Partial<SubAccountForm>; errors: string[] }): string {
  const m = opts.member;
  const f = opts.form;
  const types = ["Savings", "Christmas Club", "Money Market"].map((t) => ({ value: t, label: t, selected: f.type === t }));
  const sources = m.accounts.map((a) => ({ value: a.id, label: `${a.id} ${a.type} (${formatMoney(a.balanceCents)})`, selected: f.source === a.id }));
  return page("New Sub-Account", `
<form method="post" action="/member/${esc(m.id)}/subaccount/new">
<table class="box" cellpadding="0" cellspacing="0" width="520">
  <tr><td class="hdr" colspan="2">Open New Sub-Account for ${esc(m.firstName)} ${esc(m.lastName)} (${esc(m.id)})</td></tr>
  ${opts.errors.length ? `<tr><td colspan="2" class="c2 err">${opts.errors.map(esc).join("<br>")}</td></tr>` : ""}
  ${fieldRow("Account Type", select("type", "Account Type", types))}
  ${fieldRow("Nickname", textInput("nickname", "Nickname", f.nickname ?? "", 'maxlength="20"'))}
  ${fieldRow("Initial Deposit", textInput("deposit", "Initial Deposit", f.deposit ?? "", 'size="10"'))}
  ${fieldRow("Funding Source", select("source", "Funding Source", sources))}
  <tr><td class="c2" colspan="2" align="right">${submitButton("Continue")} &nbsp; ${jsLink("Cancel", `/member/${m.id}`)}</td></tr>
</table>
</form>
<p>Minimum initial deposit is $25.00. Nickname is required (max 20 characters).</p>`, opts);
}

export function confirmPage(opts: PageOpts & { member: Member; form: SubAccountForm; depositCents: number }): string {
  const m = opts.member;
  const f = opts.form;
  const hidden = (n: keyof SubAccountForm) => `<input type="hidden" name="${n}" value="${esc(f[n])}">`;
  return page("Confirm New Sub-Account", `
<form method="post" action="/member/${esc(m.id)}/subaccount/open" onsubmit="return confirm('Open this sub-account now? This action cannot be undone.');">
${hidden("type")}${hidden("nickname")}${hidden("deposit")}${hidden("source")}
<table class="box" cellpadding="0" cellspacing="0" width="520">
  <tr><td class="hdr" colspan="2">Review and Confirm</td></tr>
  ${fieldRow("Member", `${esc(m.firstName)} ${esc(m.lastName)} (${esc(m.id)})`)}
  ${fieldRow("Account Type", esc(f.type))}
  ${fieldRow("Nickname", esc(f.nickname))}
  ${fieldRow("Initial Deposit", esc(formatMoney(opts.depositCents)))}
  ${fieldRow("Funding Source", esc(f.source))}
  <tr><td colspan="2" class="c2 warn">Opening a sub-account posts a transfer from the funding source. This cannot be undone from this screen.</td></tr>
  <tr><td class="c2" colspan="2" align="right">${submitButton("Open Account")} &nbsp; ${jsLink("Back", `/member/${m.id}/subaccount/new`)}</td></tr>
</table>
</form>`, opts);
}

export function donePage(opts: PageOpts & { member: Member; account: Account; confirmation: string }): string {
  const m = opts.member;
  return page("Sub-Account Opened", `
<table class="box" cellpadding="0" cellspacing="0" width="520">
  <tr><td class="hdr" colspan="2">Sub-Account Opened</td></tr>
  <tr><td colspan="2" class="c2 ok">The new sub-account has been opened successfully.</td></tr>
  ${fieldRow("Confirmation Number", `<b>${esc(opts.confirmation)}</b>`)}
  ${fieldRow("New Account", esc(opts.account.id))}
  ${fieldRow("Type", esc(opts.account.type))}
  ${fieldRow("Nickname", esc(opts.account.nickname))}
  ${fieldRow("Opening Balance", esc(formatMoney(opts.account.balanceCents)))}
  <tr><td class="c2" colspan="2">${jsLink("Return to Member", `/member/${m.id}`)} &nbsp; ${jsLink("New Search", "/search")}</td></tr>
</table>`, opts);
}

export function notFoundPage(opts: PageOpts & { query: string }): string {
  return page("Member Search", `
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr">Member Search</td></tr>
  <tr><td class="c2 err">No member found for ID "${esc(opts.query)}". Verify the number and try again.</td></tr>
  <tr><td class="c2">${jsLink("Back to Search", "/search")}</td></tr>
</table>`, opts);
}

export function forbiddenPage(opts: PageOpts): string {
  return page("Access Denied", `
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr">Access Denied</td></tr>
  <tr><td class="c2 err">You are not authorized to perform this function. Contact your supervisor. (Error 403)</td></tr>
  <tr><td class="c2">${jsLink("Back to Search", "/search")}</td></tr>
</table>`, opts);
}

export function serverErrorPage(opts: PageOpts): string {
  return page("System Error", `
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr">System Error</td></tr>
  <tr><td class="c2 err">An unexpected error occurred while processing your request. Reference: SYS-${Date.now() % 100000}. (Error 500)</td></tr>
  <tr><td class="c2">${jsLink("Back to Search", "/search")}</td></tr>
</table>`, opts);
}

export function stubPage(title: string, opts: PageOpts): string {
  return page(title, `
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr">${esc(title)}</td></tr>
  <tr><td class="c2">This module is not available in the demo environment.</td></tr>
  <tr><td class="c2">${jsLink("Back to Search", "/search")}</td></tr>
</table>`, opts);
}

export function faultsPage(opts: PageOpts & { armed?: string; sticky: boolean }): string {
  const options = FAULTS.map((f) => ({ value: f, label: f, selected: f === opts.armed }));
  return page("Fault Injection (demo only)", `
<p class="warn">Hidden demo control. Arms a fault that fires at its trigger point on a later request. One-shot unless sticky.</p>
<form method="post" action="/__faults">
<table class="box" cellpadding="0" cellspacing="0" width="480">
  <tr><td class="hdr" colspan="2">Arm Fault</td></tr>
  ${fieldRow("Currently armed", esc(opts.armed ?? "none") + (opts.sticky ? " (sticky)" : ""))}
  ${fieldRow("Fault", select("fault", "Fault", [{ value: "", label: "(none)" }, ...options]))}
  ${fieldRow("Sticky", `<input type="checkbox" name="sticky" value="1" title="Sticky"${opts.sticky ? " checked" : ""}>`)}
  <tr><td class="c2" colspan="2" align="right">${submitButton("Arm")} &nbsp; <button type="submit" name="clear" value="1">Clear</button></td></tr>
</table>
</form>
<table class="box" cellpadding="4" cellspacing="0" width="480">
  <tr><td class="hdr" colspan="2">Trigger points</td></tr>
  ${[
    ["not_found", "Member search results"],
    ["validation", "Sub-account form submit"],
    ["permission_denied", "Member detail page"],
    ["session_expired", "Any authenticated page"],
    ["unexpected_dialog", "Any page render (alert)"],
    ["slow", "Any page (delay)"],
    ["server_error", "Any authenticated page"],
  ].map(([f, t]) => `<tr class="row"><td class="c1">${f}</td><td class="c2">${t}</td></tr>`).join("")}
</table>`, opts);
}

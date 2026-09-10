/**
 * HTML rendering helpers. The markup is deliberately "legacy": framesets, nested tables for
 * layout, no ids, generic class names, inline event handlers, labels as adjacent cells.
 * Accessible names come from `title` attributes and adjacent text, as in real legacy apps.
 */
export const APP_VERSION = "4.2.1";

export function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const css = `
body{font-family:Verdana,Arial,sans-serif;font-size:12px;background:#e9eef4;margin:0}
.c1{background:#dfe7f1;font-weight:bold;white-space:nowrap;padding:3px 6px}
.c2{padding:3px 6px}
.row td{border-bottom:1px solid #c9d3df}
.hdr{background:#274c77;color:#fff;font-weight:bold;padding:6px}
.box{background:#fff;border:1px solid #9fb0c4}
.err{color:#a40000;font-weight:bold}
.ok{color:#0a6b1a;font-weight:bold}
.warn{background:#fff3cd;border:1px solid #d6b656;padding:6px}
a{color:#1a3e6e}
input,select{font-size:12px}
.ft{color:#667;font-size:10px;padding:8px}
`;

/** Frameset shell: nav on the left, content on the right. */
export function frameset(): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html><head><title>Legacy CU Core</title></head>
<frameset cols="170,*" frameborder="1" border="2">
  <frame src="/nav" name="nav" scrolling="no">
  <frame src="/main" name="main">
  <noframes><body>This application requires frames. <a href="/main">Continue</a></body></noframes>
</frameset></html>`;
}

export function navFrame(loggedIn: boolean): string {
  const items = loggedIn
    ? `<tr><td class="c2"><a href="/search" target="main">Member Search</a></td></tr>
       <tr><td class="c2"><a href="#" onclick="parent.main.location='/loans';return false;">Loans</a></td></tr>
       <tr><td class="c2"><a href="#" onclick="parent.main.location='/reports';return false;">Reports</a></td></tr>
       <tr><td class="c2"><a href="/logout" target="_top">Sign Out</a></td></tr>`
    : `<tr><td class="c2"><a href="/login" target="main">Sign In</a></td></tr>`;
  return page("Navigation", `
<table width="100%" cellpadding="0" cellspacing="0" class="box">
  <tr><td class="hdr">Legacy CU Core</td></tr>
  ${items}
</table>`, { chrome: false });
}

export interface PageOpts {
  chrome?: boolean;
  user?: string;
  /** script injected before </body> (used for the unexpected-dialog fault) */
  injectScript?: string;
}

export function page(title: string, body: string, opts: PageOpts = {}): string {
  const chrome = opts.chrome ?? true;
  const top = chrome
    ? `<table width="100%" cellpadding="0" cellspacing="0"><tr>
         <td class="hdr">Legacy CU Core &mdash; ${esc(title)}</td>
         <td class="hdr" align="right">${opts.user ? `Operator: ${esc(opts.user)}` : "&nbsp;"}</td>
       </tr></table>`
    : "";
  const foot = chrome ? `<div class="ft">Legacy CU Core v${APP_VERSION} &middot; For internal use only &middot; Synthetic demo data</div>` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)} - Legacy CU Core</title><style>${css}</style></head>
<body>${top}
<table width="100%" cellpadding="6" cellspacing="0"><tr><td>${body}</td></tr></table>
${foot}
${opts.injectScript ? `<script>${opts.injectScript}</script>` : ""}
</body></html>`;
}

/** Two-column form row. Label is a cell, not a <label>; the input carries a title. */
export function fieldRow(label: string, control: string): string {
  return `<tr class="row"><td class="c1">${esc(label)}</td><td class="c2">${control}</td></tr>`;
}

export function textInput(name: string, title: string, value = "", extra = ""): string {
  return `<input type="text" name="${esc(name)}" title="${esc(title)}" value="${esc(value)}" size="24" ${extra}>`;
}

export function select(name: string, title: string, options: { value: string; label: string; selected?: boolean }[]): string {
  return `<select name="${esc(name)}" title="${esc(title)}">${options
    .map((o) => `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("")}</select>`;
}

export function submitButton(label: string, extra = ""): string {
  return `<input type="submit" value="${esc(label)}" ${extra}>`;
}

/** A link styled as legacy "button": href="#" with inline onclick navigation. */
export function jsLink(label: string, url: string): string {
  return `<a href="#" onclick="document.location='${esc(url)}';return false;">${esc(label)}</a>`;
}

export const UNEXPECTED_DIALOG_SCRIPT =
  `alert('System maintenance tonight 10:00 PM - 11:00 PM ET. Save your work.');`;

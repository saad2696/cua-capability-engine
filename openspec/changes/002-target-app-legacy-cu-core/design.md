# Design: Legacy CU Core

## Hostile markup on purpose
- Outer `<frameset>`: left nav frame, main content frame. Forces frame-aware locators.
- Layout with nested `<table>`s, no `id`s, generic class names (`c1`, `row`), inline `onclick`.
- Form labels are table cells adjacent to inputs, not `<label for>`; accessible names come from
  `title` attributes and adjacent text, which is what real legacy apps look like.
- Sub-account "Open account" triggers a native `confirm()` dialog.

## Flow and data
Members: 10042 Alex Sample, 10077 Jordan Placeholder, 10101 Sam Fixture, 10233 Casey Mock, 10999 Riley Test.
Each has Checking and Savings balances. Session cookie set at login; credentials `demo / demo`.

## Fault injection
`faults.ts` middleware reads `?fault=` or cookie `cu_fault`:

| fault | behavior |
|---|---|
| `not_found` | search returns "No member found" page |
| `validation` | sub-account form rejects with inline error |
| `permission_denied` | 403 page "You are not authorized" |
| `session_expired` | clears session, redirects to `/login` |
| `unexpected_dialog` | injects a "System maintenance tonight" `alert()` on next page |
| `slow` | 6s delay before response |
| `server_error` | 500 page |

`/__faults` shows a form to set the cookie so the console demo can trigger faults without editing URLs.

## Tenant variant (optional, later)
`?variant=tenant-b` or env `VARIANT=tenant-b`: different logo/colors, "Member ID" relabeled
"Account Holder #", balance column order swapped. Same routes.

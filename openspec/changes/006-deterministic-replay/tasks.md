# Tasks
- [x] 6.1 Pre-flight: schema, params, secrets, policy subset, approval gate
- [x] 6.2 Value resolution (`literal|param|secret`) with redaction-aware logging
- [x] 6.3 Wait strategy: condition-based waits, settle, slow-load extension
- [x] 6.4 Step executor: resolve → act → verify → detect, with drift event
- [x] 6.5 Detector pipeline (dialog, url, text, http, slow) driven by artifact outcomes + app defaults
- [x] 6.6 Recovery actions with limits and RECOVERY_LOOP guard
- [x] 6.7 Output extraction and typed parsing (money → { amount, currency })
- [x] 6.8 Final checkpoint and `ReplayResult` construction; exit codes
- [x] 6.9 Evidence writer for replay incl. failure bundle
- [x] 6.10 `cua replay <artifact> --param k=v [--allow-draft] [--fault X]`
- [x] 6.11 `docs/error-taxonomy.md`
- [x] 6.12 Integration tests vs target app: success; not_found → business_outcome; session_expired → recovered success; unexpected_dialog → failure UNKNOWN_DIALOG; slow → success with SLOW_LOAD event; server_error → retry then failure; validation → business_outcome; permission_denied → business_outcome; bad param → INVALID_INPUT without browser; css-only locator drift → success with drift event
- [x] 6.13 `--plan` mode
- [x] 6.14 Precondition verification with settle/re-observe and recoverable-outcome shortcut
- [x] 6.15 Retry matrix incl. retryable=false single attempt; optional step skip
- [x] 6.16 Side-effect tracking on results
- [x] 6.17 `--resume-from` on an existing session
- [ ] 6.18 New tab / frame re-resolution / detached element handling
- [ ] 6.19 Input robustness (fill fallback, select by label, stable bbox, state-assert for checkboxes)
- [x] 6.20 Text normalization utilities + tests
- [x] 6.21 Visual drift soft signal — box-overlap (IoU) of the resolved control against `recordedBBox`, not SSIM: it needs no stored reference image and answers the more useful question ("did the control move") directly
- [x] 6.22 Playwright trace + failure.md narrative
- [x] 6.23 Budgets, cancellation, run lock
- [x] 6.24 Tests: wrong-screen; optional step absent; retryable=false not retried; sideEffects possible after confirm failure; new tab same-origin adopted; resume-from after pause; extraction fallback; cancellation closes browser

Deferred with a reason:
- 6.18 new tab / detached element handling — the page-switch guard and per-step re-resolution are in
  place from slice 004; a dedicated multi-tab test needs the session controller from slice 007.
- 6.19 input robustness beyond fill/select-by-label — the remaining cases (checkbox state-assert)
  have no instance in either goal flow; revisit if a capability needs one.

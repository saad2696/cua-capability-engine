# Design write-up — Computer-Use Automation System

> Working document, grown slice by slice alongside the code (see `openspec/ROADMAP.md`). Each
> section records the decision, the alternative considered, the trade-off, and the extra cases
> covered. It is trimmed to 1–3 pages before submission.

## 1. Architecture

**Shape.** One TypeScript engine (`packages/engine`) behind one contracts package
(`packages/schema`), a CLI, a mock legacy bank as the target, and a thin React operator console.
Single process, files on disk, no queues or databases. The brief explicitly does not reward
scaling infrastructure; the abstractions are what must scale.

**The seam that matters: `Surface`.** Everything that touches an application goes through one
interface (`observe`, `act`, `resolve`, `captureLocator`, `readText`, `landmarkVisible`,
dialogs, page switches). The artifact never references the implementation. `PlaywrightSurface`
is the web implementation; a desktop implementation would sit on an OS accessibility API plus a
screen grab and reuse every other module unchanged.

**Perception is the accessibility tree, not the DOM (slice 004).** The model sees a screenshot
with numbered marks and a list like `[7] button "Search"`; it acts by number. Elements come from
the browser's real accessibility tree over the Chrome DevTools Protocol, *frame by frame*, with
bounding boxes from the layout engine. Why: (a) the brief's common case is a legacy UI with no
clean DOM, no ids, framesets; (b) the accessibility tree exists on desktop too, so the same
`Observation` shape works for both surfaces; (c) screenshot + coordinates remains the universal
fallback. We confirmed the trap empirically: both the Chrome extension's accessibility search
and CDP's root tree stop at the frameset boundary and see only the `<noframes>` link. Per-frame
retrieval is mandatory and is what we implemented.

**Acting is operator-like.** Clicks are coordinate clicks at the element's center after scrolling
it into view; typing is fill-and-verify with a keyboard fallback; selects use the element under
the point. This keeps action semantics identical across "by element number" (discovery) and "by
locator" (replay) and mirrors how a desktop adapter would act.

**Problems met and how they were approached.**
- *Dialogs block everything.* A native `alert()` raised during load blocks the `load` event, so a
  naive `goto(url, load)` hangs forever. Navigation now waits for "commit" and then races
  `load` against dialog appearance; observation reports the dialog on top of the last known
  state; only an explicit `dismissDialog` action clears it. Dialogs are evidence, never swallowed.
- *Coordinates in framesets.* CDP boxes are in page coordinates; Playwright's `boundingBox()` is
  too. A first implementation added the frame offset twice and clicked 170px to the right of
  every control in the main frame. Fixed and covered by a test that acts through a captured
  locator and asserts the resulting screen.
- *Frameset reload after login.* Legacy apps post to `_top`; our mock now does the same so the
  nav frame reflects the signed-in state, matching the real behavior a replay must survive.

## 2. Artifact schema

See `docs/artifact-schema.md` for the field-by-field reference. The decisions:

- **Contract first.** `inputs`, `outputs`, `checkpoint` are the API a calling agent needs; the
  steps are an implementation detail it never reads. `sensitivity` on inputs defaults to `pii`
  because in a bank the safe assumption is that caller data is sensitive.
- **No sensitive literals, enforced.** Values are `param`/`secret` references. The validator
  rejects literals typed into password/SSN/PIN-like fields and SSN-shaped literals anywhere.
  The recorder asserts `provenance.redacted: true`.
- **Locators are ordered fallbacks with a written rationale.** Role+name from the accessibility
  tree first (branding-resistant, exists on desktop), then label text (legacy table-cell
  labels), visible text, an id-free CSS path (layout-bound, honest 0.35–0.5 confidence), and a
  visual box that is trusted only when its anchor text is still within 150px. Replay records
  which candidate matched: a non-primary match is a *drift* signal, not a silent success.
- **Screen signatures before acting.** Each step's `precondition` names the URL pattern and
  ≥2-of-N landmarks. A wrong screen fails as `WRONG_SCREEN` with expected-vs-observed landmarks
  instead of a mysterious locator miss two steps later.
- **Outcome catalog.** Every non-success state is declared and classified business /
  recoverable / failure with detectors and a bounded recovery. The catalog is seeded from what
  the model actually encountered during discovery, so a messy run yields a richer artifact.
- **Side effects are explicit.** `risk` and `pointOfNoReturn` on steps; `sideEffects:
  none|possible|committed` on every result, so a caller never retries a committed transfer.
- **Two versions.** `schemaVersion` with a migration chain; `capability.version` bumped on any
  step or locator change. Lifecycle `draft → needsReview/approved → deprecated`, with approval
  metadata required by the validator.

Extra cases covered by validation: duplicate step ids across preludes and steps, dangling
param/secret references, outputs pointing at non-extract steps, parse kind mismatching output
type, recoveries referencing unknown preludes, business outcomes with recoveries, actions outside
the artifact's own policy, `optional` steps that would fail instead of skip.

## 3. Determinism & error handling

_Filled in with slice 006. Design intent is in `openspec/changes/006-deterministic-replay/design.md`._

Already in place from slice 004: condition-based waits (no sleeps except a 150ms settle),
per-frame re-resolution on every step, exactly-one-visible-match resolution with proximity
disambiguation, and dialogs surfaced as state rather than auto-dismissed.

## 4. Heterogeneity & multi-tenant

_Filled in with slices 006/013. Design intent in `openspec/changes/013-cross-tenant-variant/`._

Foundations laid: the `Surface` interface and an `Observation` built from accessibility
semantics rather than markup; locator strategies that are surface-neutral except `css`;
`app.variant` on the artifact and a documented overlay format keyed by step id.

## 5. Escalation & handoff

_Filled in with slices 007/008._

## 6. Safety

_Filled in with slice 009._ Already in place: the network allowlist hook on the surface aborts
any request outside permitted origins at the browser level (a hidden redirect cannot leak the
session); sensitive field values are redacted in the element list before the model or the
evidence sees them; secrets are referenced by name and resolved from the environment.

## 7. Cuts

_Finalised at the end._ Planned: desktop surface (interface only), multi-tenant overlays
(design; optional demo), console auth/multi-operator, database storage, LLM-assisted replay
recovery (bounded, stretch only).

---

### Appendix: target application choice

We built our own mock, **Legacy CU Core**, rather than automating a public site. The brief
allows it and the evaluation demands it: the interesting failures are runtime conditions
(not-found, validation, permission denied, session expiry, unexpected dialogs, slowness, server
errors) and only an owned target can trigger each deterministically. The mock is deliberately
hostile (frameset, nested tables, no ids, inline `onclick`, labels as adjacent cells, native
`confirm()` on the irreversible step) and carries a hidden fault-injection control with one-shot
and sticky modes. Synthetic data only.

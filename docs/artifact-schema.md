# Capability artifact schema (v1.0)

A capability artifact is the product of a successful discovery run and the input to every
replay. It is a JSON document validated by `@cua/schema` (Zod), versioned twice (schema version
and capability version), and designed to be read by three audiences: the replay engine, a human
reviewer, and a calling AI agent that only needs the contract.

Reference example: [`artifacts/examples/member-savings-balance@1.json`](../artifacts/examples/member-savings-balance@1.json).
Validate any artifact with `pnpm cua artifact validate <file>`; review it with `pnpm cua artifact summary <file>`.

## Design principles

1. **Contract first.** `inputs`, `outputs`, and `checkpoint` describe what the capability needs,
   returns, and guarantees, independently of how it gets there. An agent can call it from these alone.
2. **No sensitive literals.** Values are `{kind: "param"}` or `{kind: "secret"}` references. The
   validator rejects literals typed into password-like fields and literals shaped like SSNs.
3. **Locators are ordered fallbacks with a rationale.** Every control has several ways to be found,
   most stable first, and the artifact says why. Replay reports which one matched (drift signal).
4. **Errors are a catalog, not an afterthought.** `outcomes` declares what can happen besides
   success and classifies each as business, recoverable, or failure, with a detector and a recovery.
5. **Screen state is verified before acting, not only after.** `precondition` screen signatures
   catch "wrong screen" early; `expect` and `checkpoint` confirm progress.
6. **Side effects are explicit.** `risk` and `pointOfNoReturn` drive approval gates and the
   `sideEffects` field on every result.
7. **Surface-neutral.** Nothing references Playwright. Only the `css` locator strategy is web-specific.

## Top level

| Field | Purpose |
|---|---|
| `schemaVersion` | `"1.0"`. Migrations live in `packages/schema/src/migrate/`. |
| `capability` | Identity and lifecycle: `id`, integer `version`, `status` (`draft → needsReview/approved → deprecated`), `name`, `description`, auto-generated `summary`, `app` (`vendor`, `variant`, `surface`, `observedAppVersion`), `changelog`. |
| `requires` | `surface` and the names of `secrets` the run needs from the environment. |
| `inputs` | Typed parameters supplied per invocation. `sensitivity` defaults to `pii`. |
| `outputs` | Typed values returned, each tied to an `extract` step, with extraction fallbacks, a parser, and validation. |
| `preconditions` | Currently `{kind: "authenticated", via: "prelude:login"}`. |
| `preludes` | Named step sequences run on demand: before the flow (auth) or as a recovery (re-login). |
| `steps` | The ordered flow. |
| `checkpoint` | Final success assertions. |
| `outcomes` | The error catalog. |
| `policy` | The artifact's own allowlist; must be a subset of the global policy at replay. |
| `quality` | Confidence and stability metrics written by the stability runner (stretch slice 012). |
| `provenance` | When, which model, which run; `redacted: true` is asserted by the recorder; approval metadata. |

## Step

```jsonc
{
  "id": "step:search",                 // namespaced, unique across steps and preludes
  "intent": "Run the member search",   // plain English, derived from model reasoning (redacted)
  "action": "click",                   // navigate | click | type | select | press | extract | assert | dismissDialog
  "precondition": { ...ScreenSignature },
  "target": { ...Locator },            // required for click/type/select/extract
  "value": { "kind": "param", "name": "memberId" },   // required for type/select/press/navigate
  "output": "savingsBalance",          // extract only
  "expect": [ ...Assertion ],          // per-step checkpoint, verified after acting
  "wait": { "for": "landmark", "landmark": { "role": "cell", "name": "Member Detail" }, "timeoutMs": 8000 },
  "risk": "safe",                      // risky ⇒ approval gates
  "retryable": false,                  // defaults per action: click/press/dismissDialog false, others true
  "pointOfNoReturn": false,            // must be risky; drives sideEffects on results
  "optional": false,                   // skip when precondition not met (interstitials)
  "onFailure": "fail",                 // fail | escalate | skipIfOptional
  "timeoutMs": 10000
}
```

### Why per-step `expect` and `precondition`
A click that "worked" but changed nothing is the most common silent failure. `expect` turns
every step into a checkpoint. `precondition` is the mirror image: before acting, confirm the
screen is the one recorded, using at least `minLandmarks` of the declared landmarks so cosmetic
re-branding does not break it. Failing a precondition yields `WRONG_SCREEN` with the expected and
observed landmarks, which is far more debuggable than a locator miss two steps later.

## Locator

```jsonc
{
  "frame": ["main"],                                 // frame path; framesets are the norm in legacy apps
  "candidates": [
    { "strategy": "role",   "role": "textbox", "name": "Member ID", "confidence": 0.9 },
    { "strategy": "label",  "text": "Member ID", "confidence": 0.8 },
    { "strategy": "css",    "selector": "input[name='q']", "confidence": 0.4 },
    { "strategy": "visual", "bbox": [160,28,72,12], "viewport": [1280,800], "anchorText": "Member ID", "confidence": 0.3 }
  ],
  "rationale": "Role+name survives re-labelling of layout; css by field name is layout-independent; visual is last resort.",
  "recordedBBox": [160, 28, 72, 12]                  // disambiguates multiple matches
}
```

Strategy order reflects stability in legacy enterprise UIs: accessible role and name come from
the accessibility tree, which exists for desktop apps too and is resilient to branding.
Label text handles apps without `title`s. Visible text handles buttons and links. CSS is
layout-bound and never uses ids because legacy apps have none. Visual is the universal fallback
but is only trusted when its anchor text is still nearby. `confidence` is the recorder's prior;
`stats` are filled only by the stability runner so unattended replays never rewrite the artifact.

## Outputs and extraction

```jsonc
"savingsBalance": {
  "type": "money", "from": "step:read-savings-balance",
  "extract": {
    "candidates": [
      { "strategy": "tableCell", "rowMatch": "Savings", "columnHeader": "Current Balance", "frame": ["main"] },
      { "strategy": "regexInRegion", "pattern": "Savings[\\s\\S]{0,120}?\\$([0-9,]+\\.[0-9]{2})", "group": 1 }
    ],
    "parse": { "kind": "money", "locale": "en-US", "currency": "USD" },
    "validate": { "min": 0 }
  }
}
```

Extraction mirrors locators: ordered strategies, most semantic first. `tableCell` and
`cellRightOfLabel` exist because legacy screens are tables of labels and values. Parsed values
are validated; failure is `EXTRACTION_FAILED` with the raw text observed.

## Outcomes

| kind | meaning | replay behavior |
|---|---|---|
| `business` | a legitimate result the caller must know about (`MEMBER_NOT_FOUND`) | stop, return `business_outcome`, exit 0 |
| `recoverable` | a known condition with a fixed remedy (`SESSION_EXPIRED` → `prelude:login`) | apply `recover` up to `maxRecoveries`, log, continue |
| `failure` | an undeclared or unrecoverable state (`UNKNOWN_DIALOG`) | stop with debuggable detail; `escalate: true` pauses for a human |

Detectors: `textMatches`, `urlMatches` (frame-scoped by default), `dialogOpen`, `httpStatus`,
`landmarkVisible`. All detectors in an outcome must match. `appliesTo` narrows an outcome to
specific steps.

## Result contract (what a caller gets back)

```ts
type ReplayResult =
  | { status: "success";          outputs; ...common }
  | { status: "business_outcome"; code; message; atStep?; outputs; ...common }
  | { status: "failure";          code: FailureCode; atStep?; expected; observed; evidence; ...common }
  | { status: "escalated";        interventionId; reason; atStep?; detail; ...common }
// common: runId, capabilityId, capabilityVersion, startedAt, finishedAt, durationMs, stepsRun,
//         sideEffects: "none" | "possible" | "committed", drift[], recoveries[], evidenceDir
```

`sideEffects` is the field a bank cares about most: a `failure` with `sideEffects: "possible"`
means "do not retry blindly, a human must check". Exit codes: success and business outcome 0,
failure 2, escalated 3.

## Multi-tenant seam (design)

The base artifact is recorded on `app.variant: "default"` and contains no tenant-specific
origins beyond `policy.allowedOrigins`. A tenant overlay (stretch slice 013) may override
`candidates`, add label aliases, append outcomes, and set the origin, keyed by step id. Because
the primary locator strategies are semantic, most re-branded tenants need no overlay at all, and
the drift signal tells us when one is needed.

## Validation rules beyond types

- unique step ids across `steps` and `preludes`
- every `param` reference exists in `inputs`; every `secret` reference exists in `requires.secrets`
- no literal typed into password/SSN/PIN-like fields; no SSN-shaped literals anywhere
- every output's `from` is an `extract` step that names that output; parse kind matches output type
- recoveries and preconditions reference existing preludes; outcome codes unique
- `recoverable` outcomes have a recovery; others do not
- every step action is within `policy.allowedActions`
- `pointOfNoReturn` steps are `risky`; `optional` steps use `onFailure: skipIfOptional`
- `approved` artifacts carry `approvedBy` and `approvedAt`

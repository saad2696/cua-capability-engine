# Design: Artifact schema

## Shape

```jsonc
{
  "schemaVersion": "1.0",
  "capability": { "id", "version", "status": "draft|approved|deprecated", "name", "description",
                  "app": { "vendor", "variant", "surface": "web|desktop" } },
  "inputs":  { "<name>": { "type", "pattern?", "required", "sensitivity": "none|pii|secret", "description" } },
  "outputs": { "<name>": { "type": "string|number|money|boolean|date", "from": "step:<id>", "description" } },
  "preconditions": [ { "kind": "authenticated", "via": "prelude:login" } ],
  "preludes": { "login": [ Step... ] },
  "steps": [ Step... ],
  "checkpoint": Assertion,
  "outcomes": [ Outcome... ],
  "policy": { "allowedOrigins", "allowedActions" },
  "provenance": { "discoveredAt", "model", "runId", "redacted": true }
}
```

### Step
`{ id, action, target?: Locator, value?: Value, expect?: Assertion, risk: "safe|risky", wait?: Wait, note? }`
- `action ∈ click | type | select | press | navigate | extract | assert`
- `Value = { literal } | { param } | { secret }`. Literals are allowed only when the value did not come from an input parameter and is not sensitive.
- `expect` is the per-step checkpoint: `urlMatches | textVisible | valueEquals | elementVisible | dialogOpen`.

### Locator (robustness is the point)
```jsonc
{ "frame": ["main"],
  "candidates": [
    { "strategy": "role",   "role": "textbox", "name": "Member ID" },
    { "strategy": "label",  "text": "Member ID" },
    { "strategy": "text",   "text": "Search", "exact": true },
    { "strategy": "css",    "selector": "table tr:nth-child(2) input" },
    { "strategy": "visual", "bbox": [x,y,w,h], "anchorText": "Member ID", "viewport": [1280,800] }
  ],
  "rationale": "Role+name is stable across tenants; css is layout-bound; visual is last resort." }
```
Candidates are tried in order on replay. The resolver records which one matched (drift signal).

### Outcome
`{ code, kind: "business|recoverable|failure", detect: Detector, recover?: "prelude:<name>|dismissDialog|retry", escalate?: boolean, message }`
Detectors: `textMatches | urlMatches | dialogOpen | httpStatus | elementVisible`.

### ReplayResult (discriminated union)
```ts
| { status: "success", outputs, stepsRun, evidenceDir }
| { status: "business_outcome", code, message, atStep, evidenceDir }
| { status: "failure", code, atStep, expected, observed, evidenceDir }
| { status: "escalated", interventionId, atStep, reason, evidenceDir }
```

## Versioning
`capability.version` is an integer bumped on any step/locator change. `schemaVersion` is bumped
on schema changes with a migration note. Artifact file name: `<id>@<version>.json`.

## Multi-tenant seam (design only)
A future `overlays/<tenant>.json` may override `locator.candidates`, `preludes`, and
`policy.allowedOrigins` by step id. The base artifact never contains tenant-specific origins.

## Robustness additions (v1.0 schema, decided up front)

### Screen signatures as step preconditions
Every step carries `precondition: ScreenSignature` captured at discovery time:
```jsonc
"precondition": {
  "urlPattern": "^/search(\\?.*)?$",              // canonicalized, params → :name
  "landmarks": [ { "role": "heading", "name": "Member Search" }, { "role": "textbox", "name": "Member ID" } ],
  "frames": ["main"],
  "negative": [ { "kind": "textVisible", "pattern": "error|not authorized", "flags": "i" } ]
}
```
Replay verifies the signature *before* acting. This catches "we are on the wrong screen" early
and produces `WRONG_SCREEN` with the expected vs observed signature instead of a confusing
`LOCATOR_NOT_FOUND` two steps later. `landmarks` need ≥2 of N to match (configurable) so minor
re-branding does not break preconditions.

### Step semantics
```jsonc
{ "retryable": true,               // typing/clicking a link is idempotent; submitting a form is not
  "pointOfNoReturn": false,        // true on the step whose success commits a side effect
  "timeoutMs": 8000,
  "onFailure": "fail|escalate|skipIfOptional",
  "optional": false }              // e.g. dismissing a marketing interstitial that may not appear
```
`retryable: false` steps are attempted exactly once; any failure after a `pointOfNoReturn`
step sets `sideEffects: "possible"` on the result so a calling agent never retries a transfer blindly.

### Locator candidate metadata
Each candidate carries `{ strategy, ..., confidence: 0–1, stats?: { attempts, hits, lastHitAt } }`.
`confidence` is set by the recorder (role+name 0.9, label 0.8, text 0.7, css 0.4, visual 0.3);
`stats` are updated by the stability runner (slice 012), never by an unattended replay, so the
artifact stays a reviewed document. Ambiguity resolution: when a candidate matches several
elements, prefer the one closest to the recorded bbox and with the recorded anchor text nearby.
Visual candidate stores a perceptual hash of the anchor region for a soft match.

### Extraction contract
```jsonc
"outputs": {
  "savingsBalance": {
    "type": "money", "currency": "USD", "from": "step:7", "required": true,
    "extract": {
      "candidates": [
        { "strategy": "cellRightOfLabel", "label": "Savings" },
        { "strategy": "locator", "locator": { ... } },
        { "strategy": "regexInRegion", "region": "main", "pattern": "Savings[^$]*\\$([0-9,]+\\.[0-9]{2})" }
      ],
      "parse": { "kind": "money", "locale": "en-US" },
      "validate": { "min": 0 }
    }
  }
}
```
Extraction has fallbacks like targeting does, and parsed values are validated. Extraction
failure is `EXTRACTION_FAILED` with the raw text observed.

### Waits recorded from observation
The recorder observes what actually happened after each action (url changed, network burst,
new landmark appeared, dialog) and writes a matching `wait` condition instead of a generic one:
`{ "for": "landmark", "landmark": { "role": "heading", "name": "Member Detail" }, "timeoutMs": 8000 }`.

### Reviewer aids
- `summary`: auto-generated plain-English list of steps ("1. Type memberId into Member ID. 2. Click Search. …").
- `requires`: `{ "surface": "web", "schemaVersion": "1.0", "secrets": ["TARGET_USER","TARGET_PASSWORD"] }` so a caller knows what environment is needed.
- `changelog`: `[ { version, date, author, note } ]`.
- `schemaVersion` migrations live in `packages/schema/src/migrate/` with a test per version.

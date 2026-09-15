# Tasks
- [x] 9.1 policy.yaml schema (Zod) + loader + defaults
- [x] 9.2 Allowlist checks: decision-time hook, surface boundary, network route interception
- [x] 9.3 Risk classifier with tests
- [x] 9.4 Redactor: values, events, artifact, prompt snapshot; sensitive field detection
- [x] 9.5 Wire approval gate + riskyStepsRequire modes into replay
- [x] 9.6 `cua doctor` (env present, .env untracked, target reachable, policy valid)
- [x] 9.7 Tests listed in design
- [x] 9.8 README "Safety" section; REPORT notes on limits

Departures from design.md, recorded in docs/adr/:
- 0002 — the risk classifier returns two grades (`risky` / `sideEffect: possible`) rather than the
  single boolean the design specified. With `formSubmitIsRisky: true` against one grade, both posts
  in the sub-account flow escalate, including the validation step that commits nothing; an operator
  asked to approve that learns to click through the one that matters.
- Enforcement layer 2 is `PolicyEnforcedSurface`, a wrapper implementing `Surface`, not a check
  inside `Surface.act`/`navigate` as the design wrote it. Putting policy in the surface contract
  contradicts ADR 0001 from slice 007, and the two wrappers compose instead.

Carried forward, with a reason:
- Screenshot masking (`redaction.maskEvidenceScreenshots`) is not implemented. The field is typed as
  the literal `false` so no deployment can claim it by flipping a flag. Bboxes are already recorded
  for every element the engine touches, so the blur is a contained follow-up; see README "Known
  limits" and evidence/README.md.
- Console authentication. The control plane binds to loopback and assumes one trusted operator; the
  intervention record already carries `approvedBy` for the identity that would replace that
  assumption. Listed as a cut in REPORT § 7.

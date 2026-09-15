# 0002 — Risk has two grades, so a form submit is not an escalation

- **Slice:** 009 (policy and guardrails)
- **Status:** accepted
- **Departs from:** `openspec/changes/009-policy-guardrails/design.md`, "Risk classification"

## What the design called for

A single boolean. An action is `risky` if any signal matches, and `formSubmitIsRisky: true` is one
of those signals — so every form submission is risky and, under `discovery.onRisky: escalate`, stops
for a human.

## What was built

`classifyRisk` returns two fields: `risk: safe | risky` and `sideEffect: none | possible |
committed`. A form submit that matches no irreversible signal is `safe` + `possible` and runs. A
submit whose button text or target URL matches the irreversible lists is `risky` + `committed` and
stops.

## Why

The sub-account flow in the mock app posts twice. `Continue` posts to `/member/:id/subaccount/new`,
which validates the form and re-renders it — nothing is committed, and the user can walk away. Only
`Open Account`, posting to `/member/:id/subaccount/open`, moves money and issues a confirmation
number.

Under the design as written, both posts escalate. That is not "more careful": an operator who is
asked to approve a validation step learns that the prompt is noise, and clicks through the one that
matters at the same speed as the one that does not. The gate's value is entirely in its precision.

The second grade was already in the vocabulary. `ReplayResult.sideEffects` has used `none |
possible | committed` since slice 003 to describe what a *finished* run did. Reusing the words for
what a *proposed* action may do means an operator learns one set rather than two.

It is worth being exact about the limit of that reuse: the classifier's grade is a prediction, the
result field is a record, and nothing couples them mechanically. The artifact carries
`pointOfNoReturn` — which the schema permits only on a `risky` step — and the executor promotes the
result from `possible` to `committed` as that step succeeds. Coupling the prediction to the record
would mean a new step field, which this slice did not need.

## What this gives up

An irreversible action behind a button labelled something the list does not anticipate — "Proceed",
"Finish" — is graded `possible` and runs unattended. Three things limit the damage: the artifact
records `sideEffects: possible`, which is visible at review time; `replay.riskyStepsRequire` can be
set to `humanConfirm` to pause on every run regardless of grade; and the model can mark a step
irreversible itself (`modelFlagged`), which is honoured whatever the text says. The real mitigation
is that the list lives in `policy.yaml` and is meant to be edited per deployment.

## How it is checked

`packages/engine/src/policy/policy.test.ts` reads the button labels out of
`apps/target-app/src/views/pages.ts` with a regex rather than restating them, and fails if the app
stops rendering a control that matches. An earlier classifier anchored its pattern at the start of
the name (`^\s*(open account)\b`) and matched a test written against `"Open Account"` while failing
against every label the app actually draws. A test that quotes the source cannot drift that way.

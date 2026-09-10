# Change (stretch): Generate a Playwright test from an artifact

## Why
Shows the artifact is a complete, executable description independent of our engine, and gives
QA teams something familiar.

## What changes
`cua codegen <artifact> --out tests/generated/` emits a Playwright test using the same locator
order (role → label → text → css) with `test.step` per artifact step, parameterized via env,
asserting the checkpoint. Generated test runs green against the target app.

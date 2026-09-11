# Replay failure: RECOVERY_LOOP

Capability: member-savings-balance@2
Step: step:click-button-sign-in — Submit login form
Side effects: none

**Expected:** at most 1 recovery(ies) for SESSION_EXPIRED
**Observed:** SESSION_EXPIRED triggered 2 times at this step

## Suggested next action
A recovery kept re-triggering. The underlying condition is persistent; escalate to an operator. Safe to retry once the cause is fixed.

## Evidence
- fullPage: screenshots/007-failure-click-button-sign-in-fullpage.png
- screenshot: screenshots/008-failure-click-button-sign-in-viewport.png
- a11y: failure-click-button-sign-in-a11y.json
- text: failure-click-button-sign-in-text.txt
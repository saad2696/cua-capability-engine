# Replay failure: POLICY_VIOLATION

Capability: member-open-subaccount@1
Step: step:click-button-open-account — Human approved; proceed to open the account.
Side effects: none

**Expected:** no risky steps (policy: block)
**Observed:** step:click-button-open-account is risky

## Suggested next action
Safe to retry once the cause is fixed.

## Evidence
- fullPage: screenshots/011-failure-click-button-open-account-fullpage.png
- screenshot: screenshots/012-failure-click-button-open-account-viewport.png
- a11y: failure-click-button-open-account-a11y.json
- text: failure-click-button-open-account-text.txt
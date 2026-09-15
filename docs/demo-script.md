# Demo video — running order

Twelve minutes, seven acts. Each act has the exact command, what to point at, and the one sentence
that makes the point. The order is deliberate: every act sets up the next one, and the two that
matter most (escalation, and the commit) come after the audience already trusts what they are
looking at.

If you have to cut, cut Act 2 (discovery) to 45 seconds and keep Acts 5 and 6 whole.

---

## Before you press record

```bash
pnpm cua doctor              # all green, no failures
pnpm build && pnpm test      # optional, but a green suite on camera is worth 20 seconds
```

**Reset the state you will show.** Two things drift between rehearsals:

```bash
# 1. G1's artifact must be a DRAFT for the approval beat in Act 3 to work
python3 - <<'PY'
import json
p="artifacts/member-savings-balance@2.json"; c=json.load(open(p))
c["capability"]["status"]="draft"; c["provenance"].pop("approvedBy",None); c["provenance"].pop("approvedAt",None)
json.dump(c,open(p,"w"),indent=2); open(p,"a").write("\n")
PY

# 2. G2's artifact is currently APPROVED, which is what Act 6 wants. Leave it.
#    Each G2 replay opens a real account, so the confirmation number climbs within a session
#    (CU-700001, -2, …). Restarting the target app resets it, and `pnpm demo` restarts it — so
#    every rehearsal starts from CU-700001 as long as you restart the stack. Say on camera that
#    the number moves: that is the proof the run really committed something.
```

**Terminal:** one window, large font, ~100 columns. Close anything with a personal name in it. The
mock app's data is synthetic, but your desktop is not.

**Start everything:**

```bash
pnpm demo                    # target app + engine + console, colour-prefixed, Ctrl-C stops all three
```

- console → http://localhost:4300
- mock bank → http://localhost:4100 (`demo` / `demo`)

---

## Act 1 — the problem, and the thing being automated (60s)

**Show:** the mock bank at `localhost:4100`. Sign in, search `10042`, look at the member page.

> "This is a 1990s-era core banking UI. Framesets, table layouts, no API, no test ids. This is the
> kind of system that still runs and that nobody will rewrite. The task is to automate work in it."

Point at one thing specifically — the nested frames, or the fact that the balance lives in an
unlabelled `<td>`. It makes Act 2's perception step land.

---

## Act 2 — the model learns the task once (90s)

**Command:**

```bash
pnpm cua discover \
  --goal "Look up member {memberId} and read the current balance of their Savings account." \
  --url http://localhost:4100/ --capability-id member-savings-balance --param memberId=10042
```

**Say while it runs:** the model sees an accessibility tree plus a numbered screenshot, not raw
HTML; `{memberId}` is a parameter, and the password is a reference to an environment variable that
never reaches the model.

**Then show the artifact, not the log:**

```bash
pnpm cua artifact summary artifacts/member-savings-balance@1.json
```

> "That is the output. Not a transcript — a typed, versioned contract: steps, locators with
> fallbacks, what it expects to see, and what it knows can go wrong."

---

## Act 3 — replay, with no model in the loop (90s)

**The refusal first.** This is the beat people remember:

```bash
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10042
#   -> FAILURE ARTIFACT_NOT_APPROVED
```

> "A model worked this out once. That does not make it allowed to run unattended."

Approve it in the console (**Capabilities → Approve**), then:

```bash
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10042
#   -> SUCCESS  {"savingsBalance":{"amount":1234.56,"currency":"USD"}}  ~2s

pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10077
#   -> SUCCESS  $8,900.04
```

> "Two seconds, no model, no API cost, same answer every time. And the second run proves the
> parameter is real rather than baked into the recording."

---

## Act 4 — when the application says no, or breaks (2 min)

Run these three back to back and read the **exit codes** aloud — that is the whole point.

```bash
pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=99999
#   -> BUSINESS_OUTCOME MEMBER_NOT_FOUND   exit 0

pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10042 --fault session_expired
#   -> SUCCESS after re-running the login prelude   exit 0

pnpm cua replay artifacts/member-savings-balance@2.json --param memberId=10042 --fault session_expired:sticky
#   -> FAILURE RECOVERY_LOOP   exit 2
```

> "Three different kinds of wrong. 'No such member' is an answer, not an error — exit 0. A session
> expiry is recoverable, so it fixes it and carries on. The same expiry that never clears is
> bounded, then reported. A caller can branch on these without parsing a log."

Then open the failure bundle for the last one — `evidence/replay-g1-recovery-loop/failure-*.md` —
and show that it names the expected state, the observed state, and a suggested next action.

---

## Act 5 — a human takes over the *same live session* (2.5 min)

This is the part the brief cares about most. Do it in the console.

1. On the console's **entry page** (the landing screen), pick `member-savings-balance@2`, member
   `10042`, tick **pause at start**, and start it. A clean run finishes faster than anyone can
   click, so pausing at the start is how you get to drive at all.
2. In **Break something**, press **"Undeclared error on the next click"** — the highlighted one.
3. Let it run. The engine stops: `UNKNOWN_DIALOG`, and the run state becomes `human_control`.

> "It did not guess. The dialog is not in the artifact's outcome catalog, so it refuses to touch it
> and asks for a person."

4. **Take control.** Point at the live viewport — this is the automation's own browser, not a
   screenshot. Dismiss the dialog yourself by clicking in it.
5. **Hand back.** The run resumes *in the step it stopped at* and finishes.

> "Seven steps. An uninterrupted run of this capability is also seven steps — so it resumed the
> session it paused in rather than starting a new one. The browser was never restarted, and the
> cookies, the frames and the scroll position are the ones my clicks left behind."

Show **Interventions**: who claimed it, when, how it was resolved.

---

## Act 6 — the flow that actually commits something (2.5 min)

G1 reads. G2 opens an account. This is where the guardrails earn their place.

**Show the evidence of the real run first** (it takes 40s of model time live, which is dead air):

```bash
cat evidence/discovery-g2-open-subaccount/run.json | head -20      # 15 steps, 15 calls, $0.14
```

Open `evidence/discovery-g2-open-subaccount/interventions.json` and show **three** interventions.

> "Claude worked this one out too — and it stopped three times. The second and third are the
> policy: the button whose label matches the irreversible list, and the browser confirm dialog that
> actually opens the account. The *first* one the model raised itself, before any rule fired — it
> reached the review screen and asked for a human on its own."

**Then the two replays, back to back.** Same artifact, same parameters:

```bash
pnpm cua replay artifacts/member-open-subaccount@1.json --param memberId=10042
#   -> SUCCESS  {"confirmationNumber":"CU-7000NN"}  side effects: committed   exit 0

pnpm cua replay artifacts/member-open-subaccount@1.json --param memberId=10042 --risky block
#   -> FAILURE POLICY_VIOLATION  side effects: none   exit 2
```

> "Same capability, same inputs, one line of policy different, and the difference is whether an
> account gets opened. The guardrail belongs to the deployment, not to the recorded flow."

Show the new account in the mock bank UI, and say the confirmation number changes every run because
each run really opens one. That is what `committed` means.

---

## Act 7 — safety and evidence (90s)

```bash
pnpm cua doctor
```

> "The secret check asks git, not `.gitignore` — those two disagree exactly when a file was staged
> before the ignore rule was, which is the case that actually leaks a key."

Then `policy.yaml` on screen, scrolled slowly:

> "Everything the engine may do is one validated file. Four layers enforce it: the model's decision,
> the surface, the network, and a pre-flight check on the artifact. A human who takes control is not
> blocked by it — they are *recorded* as an override, because refusing them would disable escalation
> exactly when it is needed."

Finish on `evidence/` — one directory per run, `events.jsonl`, screenshots, the failure bundle. Say
the honest limit out loud:

> "Screenshots are not masked. They render whatever was on screen. The schema pins that flag to
> false so nobody can claim otherwise, and it is written down in the README."

---

## Close (30s)

> "An LLM works the task out once, under policy, with a human for anything irreversible. What it
> learned becomes a typed artifact that runs deterministically for two seconds with no model and no
> API cost — and when the application does something it has not seen, it stops and hands a person
> the same live browser rather than guessing."

---

## Pitfalls that have bitten this demo

| Thing | What happens | Fix |
|---|---|---|
| G1 artifact left approved | Act 3's refusal beat does not fire | Reset to draft (top of this file) |
| Running Act 6 twice | Confirmation number increments | Expected — say it on camera |
| `pnpm demo` not given time | Console loads before the engine | Wait for all three "ready" lines |
| Editing source mid-demo | CLI runs `dist` | `pnpm --filter @cua/engine build` |
| Recording the whole screen | `.env` may be visible in an editor | Share the terminal window only |

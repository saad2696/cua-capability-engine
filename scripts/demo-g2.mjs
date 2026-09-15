#!/usr/bin/env node
/**
 * Goal G2, driven by a real model, through the control plane the console talks to.
 *
 * "Open a new savings sub-account and read the confirmation number" is the flow that actually
 * commits something, so it is the one where the guardrails have to hold. The engine stops twice —
 * once before clicking the button whose label matches the irreversible list, and again before
 * accepting the confirm dialog the application raises, which is the step that really opens the
 * account. This script plays the operator: it reads each intervention, prints what it was asked to
 * approve, and answers it over HTTP exactly as the console does.
 *
 * It exists because the alternative — `cua discover --approve-risky` — approves everything in
 * advance, which demonstrates nothing about escalation and would auto-accept a commit no human had
 * seen.
 *
 *   pnpm dev:target                       # terminal 1
 *   pnpm cua serve                        # terminal 2
 *   node scripts/demo-g2.mjs              # terminal 3
 *
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const server = arg("server", "http://127.0.0.1:4200");
const member = arg("member", "10042");
const target = arg("target", "http://localhost:4100");

const api = async (path, method = "GET", body) => {
  const res = await fetch(`${server}${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const say = (s) => console.log(s);
const until = async (fn, ms = 300_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the run");
    await new Promise((r) => setTimeout(r, 300));
  }
};

const health = await api("/api/health");
if (health.status !== 200) {
  console.error(`no engine at ${server}. Start one with:  pnpm cua serve`);
  process.exit(1);
}
try {
  const t = await fetch(`${target}/login`, { signal: AbortSignal.timeout(2000) });
  if (t.status >= 500) throw new Error(String(t.status));
} catch {
  console.error(`no target app at ${target}. Start one with:  pnpm dev:target`);
  process.exit(1);
}

const goal = `Open a new savings sub-account for member {memberId} with nickname "Holiday" and an initial deposit of $50.00, funded from the checking account, and read the confirmation number shown when it is done.`;

say(`\n1. asking the model to work out how to open a sub-account for member ${member}`);
say(`   this is the flow that commits something, so it is the one the guardrails are for\n`);

const started = await api("/api/discover", "POST", {
  goal,
  url: `${target}/`,
  capabilityId: "member-open-subaccount",
  params: { memberId: member },
});
if (started.status !== 201) {
  console.error(`could not start discovery: ${started.status} ${JSON.stringify(started.body)}`);
  process.exit(1);
}
const runId = started.body.id;
say(`   run ${runId}\n`);

/** Approve one intervention the way an operator would: read it, then answer it. */
const answered = [];
const handle = async (iv) => {
  say(`2.${answered.length + 1} the engine has stopped and is asking a person`);
  say(`     reason:  ${iv.reason}`);
  say(`     about:   ${iv.detail}`);
  if (iv.url) say(`     on:      ${iv.url}`);
  await api(`/api/interventions/${iv.id}/claim`, "POST", { by: "operator-1" });
  await api(`/api/interventions/${iv.id}/resolve`, "POST", { resumeAt: "same", by: "operator-1" });
  say(`     approved by operator-1; control handed back to the engine\n`);
  answered.push(iv.reason);
};

const seen = new Set();
const done = await until(async () => {
  const r = (await api(`/api/runs/${runId}`)).body;
  for (const iv of r.session?.interventions ?? []) {
    if (iv.status === "open" && !seen.has(iv.id)) {
      seen.add(iv.id);
      await handle(iv);
    }
  }
  return r.finishedAt ? r : undefined;
});

const d = done.discovery ?? {};
say(`3. run ${d.status ?? done.status}: ${d.stepsTaken ?? "?"} steps, ${answered.length} human decision(s)`);
if (d.artifactPath) say(`   artifact:  ${d.artifactPath}`);
if (d.warnings?.length) for (const w of d.warnings) say(`   warning:   ${w}`);
say(`   evidence:  ${done.evidenceDir}`);
say(`   the account it opened is real, in the mock core: the confirmation number is in the artifact's outputs.\n`);

if (!answered.length) {
  console.error("NOTE: nothing escalated. The commit should have stopped for a human twice.");
  process.exitCode = 1;
}

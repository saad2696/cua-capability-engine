#!/usr/bin/env node
/**
 * One command for the whole demonstration: the mock bank, the engine, and the console.
 *
 * Written as a script rather than a `concurrently` dependency so that the output stays readable —
 * each child is prefixed and colourised, a crash in one is reported rather than silently losing a
 * third of the demo, and Ctrl-C takes all three down together instead of orphaning a browser.
 *
 *   pnpm demo [--headed]
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const headed = process.argv.includes("--headed");
const CONSOLE_URL = "http://localhost:4300";
const colour = (n) => "\u001b[" + n + "m";
const RESET = colour(0);

const SERVICES = [
  { name: "target ", colour: colour(35), cmd: "pnpm", args: ["dev:target"], ready: "http://localhost:4100/login" },
  { name: "engine ", colour: colour(36), cmd: "pnpm", args: ["serve", ...(headed ? ["--headed"] : [])], ready: "http://127.0.0.1:4200/api/health" },
  { name: "console", colour: colour(32), cmd: "pnpm", args: ["dev:console"], ready: CONSOLE_URL },
];

const children = [];
let shuttingDown = false;

const stop = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const waitFor = async (url, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) return false;
    await sleep(300);
  }
};

for (const svc of SERVICES) {
  const child = spawn(svc.cmd, svc.args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  children.push(child);
  const prefix = `${svc.colour}${svc.name}${RESET} | `;
  const pipe = (stream) =>
    stream.on("data", (b) => {
      for (const line of String(b).split("\n")) if (line.trim()) process.stdout.write(prefix + line + "\n");
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    // Losing one service silently would leave a demo that half works, which is worse than stopping.
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    stop(code ?? 1);
  });

  if (!(await waitFor(svc.ready))) {
    process.stdout.write(`${prefix}did not come up at ${svc.ready}\n`);
    stop(1);
  }
}

console.log(`
  everything is up:

    console   ${CONSOLE_URL}          start here
    engine    http://127.0.0.1:4200/api/health
    bank app  http://localhost:4100/login   (operator demo / demo)

  try, in order:
    1. Replay "member-savings-balance@2" for member 10042 - deterministic, no model, about two seconds.
    2. Replay it again with "Session expired" selected - the engine notices and signs back in.
    3. Replay, then "Force a human intervention": take control, click in the live browser, hand back.
    4. Discover with the scripted model to watch an artifact being recorded.

  Ctrl-C stops all three.
`);

await new Promise(() => {});

/**
 * Runs in flight, and everything a console needs to watch or steer one.
 *
 * A run here is not a subprocess. The engine, the session, the browser and the evidence writer all
 * live in this process, which is what makes "take control of the same live session" possible at all:
 * the operator's clicks go to the very browser the replay was using, not to a copy of it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability, DiscoveryResult, Event, ReplayResult } from "@cua/schema";
import { runDiscovery } from "../agent/loop.js";
import { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import { Redactor } from "../evidence/redactor.js";
import { runPolicy } from "../policy/load.js";
import { replay } from "../replay/executor.js";
import { Session } from "../session/Session.js";
import { PlaywrightSurface } from "../surface/playwright/PlaywrightSurface.js";
import { PolicyEnforcedSurface } from "../policy/PolicyEnforcedSurface.js";
import type { LlmProvider } from "../llm/types.js";
import type { Surface } from "../surface/types.js";

export type RunStatus = "starting" | "running" | "paused" | "human_control" | "completed" | "failed";

export interface RunRecord {
  id: string;
  kind: "replay" | "discover";
  capabilityId: string;
  capabilityVersion: number;
  params: Record<string, string>;
  /**
   * Derived, never assigned. An earlier version stored it and had every run stick on "running"
   * forever: releasing the engine's lease during teardown fired a change callback that recomputed
   * the field from a session still marked running, clobbering the value the finally block had just
   * written. A run's status is a function of what has happened to it, so it is written as one.
   */
  readonly status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  result?: ReplayResult;
  /** Discovery runs report a different shape; the console renders whichever is present. */
  discovery?: DiscoveryResult | { status: string; stepsTaken: number; artifactPath?: string };
  evidenceDir: string;
  /** The run's evidence writer: the server subscribes to it to stream events live. */
  evidence: EvidenceWriter;
  /** Origins this run is allowed to touch; the first is the app's base URL. */
  origins: string[];
  session: Session;
  surface: Surface;
  /** The last N events, so a console that connects late still has context. */
  recent: Event[];
}

export interface StartReplayInput {
  artifact: Capability | unknown;
  params?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Arm one of the mock app's faults before the run starts (demo only). */
  fault?: { name: string; sticky?: boolean };
  headless?: boolean;
  allowDraft?: boolean;
  escalateOnFailure?: boolean;
  riskyStepsRequire?: "approvedArtifact" | "humanConfirm" | "block";
  runTimeoutMs?: number;
  interventionTimeoutMs?: number;
  /**
   * Raise an intervention before the first step runs. A read-only replay finishes in about two
   * seconds, which is faster than anybody can click "pause", so without this the takeover path is
   * only reachable by luck. It is also the cautious way to run a capability for the first time.
   */
  pauseAtStart?: boolean;
  /** Pace the run so it can be watched. Purely presentational; see ReplayOptions.stepDelayMs. */
  stepDelayMs?: number;
}

export interface StartDiscoveryInput {
  goal: string;
  url: string;
  capabilityId: string;
  provider: LlmProvider;
  params?: Record<string, string>;
  secrets?: Record<string, string>;
  maxSteps?: number;
  headless?: boolean;
  interventionTimeoutMs?: number;
}

const RECENT_CAP = 200;

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<(r: RunRecord) => void>();

  /**
   * `policyPath` is explicit rather than read from the ambient environment so that a test can point
   * one server at one policy file without mutating `process.env`, which every other test file in a
   * parallel run would see. Left undefined, `runPolicy()` resolves it the way the CLI does.
   */
  constructor(
    private readonly evidenceRoot: string,
    private readonly policyPath?: string,
  ) {}

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }
  /** Find the run that owns an intervention, so the console can address it by intervention id alone. */
  findByIntervention(interventionId: string): RunRecord | undefined {
    return [...this.runs.values()].find((r) => r.session.allInterventions.some((i) => i.id === interventionId));
  }
  onChange(fn: (r: RunRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(r: RunRecord): void {
    for (const fn of this.listeners) {
      try {
        fn(r);
      } catch {
        /* ignore */
      }
    }
  }

  async startReplay(input: StartReplayInput): Promise<RunRecord> {
    const raw = input.artifact as { capability?: { id?: string; version?: number }; policy?: { allowedOrigins?: string[] } };
    const capabilityId = raw.capability?.id ?? "unknown";
    const runId = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    const params = input.params ?? {};
    const secrets = input.secrets ?? {};

    const redactor = new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } });
    const evidence = new EvidenceWriter(runId, this.evidenceRoot, redactor);
    const origins = raw.policy?.allowedOrigins?.length ? raw.policy.allowedOrigins : ["http://localhost:4100"];
    const { gate: policy, policy: doc } = runPolicy({ origins, ...(this.policyPath ? { path: this.policyPath } : {}) });
    const surface = new PlaywrightSurface({ headless: input.headless ?? true, allowRequest: (u) => policy.allowRequest(u), tracePath: join(evidence.dir, "trace.zip") });
    surface.onPageSwitch((u) => (policy.allowRequest(u) ? "adopt" : "close"));

    const record: RunRecord = {
      id: runId, kind: "replay", capabilityId, capabilityVersion: raw.capability?.version ?? 1, params,
      get status(): RunStatus {
        if (this.finishedAt) return this.result?.status === "success" || this.result?.status === "business_outcome" ? "completed" : "failed";
        if (!this.session) return "starting";
        if (this.session.state === "human_control") return "human_control";
        if (this.session.state === "paused") return "paused";
        if (this.session.state === "idle") return "starting";
        return "running";
      },
      startedAt: new Date().toISOString(), evidenceDir: evidence.dir, evidence, surface, origins,
      recent: [],
      session: undefined as unknown as Session,
    };

    // Enforcement layer 2: every lease the session hands out — to the engine or to a human who has
    // taken control — resolves through this wrapper, so replay passes the same allowlist check the
    // model's decisions do. A human is not stopped, only recorded.
    const live: { session?: Session } = {};
    const guarded = new PolicyEnforcedSurface(surface, {
      gate: policy,
      controller: () => live.session?.controller ?? "replay",
      onBlock: (action, reason) => evidence.event({ type: "policy_block", action, reason, controller: "replay" }),
      onOverride: (by, action, reason) => evidence.event({ type: "policy_override", action, reason, by }),
    });
    const session = new Session({
      runId, surface: guarded, evidence, engineController: "replay", capabilityId,
      ...(input.interventionTimeoutMs ? { interventionTimeoutMs: input.interventionTimeoutMs } : {}),
      onChange: () => this.changed(record),
    });
    record.session = session;
    live.session = session;
    this.runs.set(runId, record);

    evidence.subscribe((e) => {
      record.recent.push(e);
      if (record.recent.length > RECENT_CAP) record.recent.shift();
    });

    const engineSurface = session.start();
    this.changed(record);
    if (input.pauseAtStart) {
      // Open the application before stopping. A capability whose first step is a navigation has no
      // page yet at this point, so pausing without this leaves the operator looking at an empty
      // viewport and wondering what broke. The flow's own first step navigates to the same origin.
      await engineSurface.open(origins[0]!).catch(() => {});
      // Raised before the loop starts, so the engine blocks on its first shouldContinue check.
      await session.pause("operator");
    }

    const cookies = input.fault
      ? [{ url: origins[0]!, name: "cu_fault", value: input.fault.name }, ...(input.fault.sticky ? [{ url: origins[0]!, name: "cu_fault_sticky", value: "1" }] : [])]
      : [];

    // Deliberately not awaited: the caller gets a run id immediately and watches it over SSE.
    void (async () => {
      try {
        const result = await replay({
          artifact: input.artifact, params, secrets, surface: engineSurface, evidence,
          globalPolicy: { allowedOrigins: origins },
          allowDraft: input.allowDraft ?? true,
          // A console run is attended, so it tightens the document rather than following it: an
          // operator is already watching, and asking them is cheaper than failing. It never
          // loosens — a policy of `block` stays `block`.
          escalateOnFailure: input.escalateOnFailure ?? true,
          riskyStepsRequire: input.riskyStepsRequire ?? (doc.replay.riskyStepsRequire === "block" ? "block" : "humanConfirm"),
          runTimeoutMs: input.runTimeoutMs ?? doc.runTimeoutMs,
          ...(input.stepDelayMs ? { stepDelayMs: input.stepDelayMs } : {}),
          cookies,
          onEscalate: session.onEscalate,
          shouldContinue: session.shouldContinue,
          confirmRisky: session.confirmRisky,
        });
        record.result = result;
      } catch (e) {
        evidence.event({ type: "error", code: "SURFACE_ERROR", message: (e as Error).message });
      } finally {
        record.finishedAt = new Date().toISOString();
        // Read from the result rather than from record.status: the getter derives its answer from
        // finishedAt, so asking it here would silently depend on the line above running first.
        session.finish(record.result?.status === "success" || record.result?.status === "business_outcome" ? "completed" : "aborted");
        await surface.close().catch(() => {});
        this.changed(record);
      }
    })();

    return record;
  }

  /**
   * Start an LLM-driven discovery run under the same session control as a replay.
   *
   * Discovery escalates rather than guesses: a risky action becomes an intervention a person answers
   * in the live browser, instead of a flag decided before the run began. The provider is injected,
   * so the console can drive either a real model or the scripted fake one with no key and no cost.
   */
  async startDiscovery(input: StartDiscoveryInput): Promise<RunRecord> {
    const runId = `run-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
    const params = input.params ?? {};
    const secrets = input.secrets ?? {};
    const origin = new URL(input.url).origin;

    const redactor = new Redactor({ secrets: { ...secrets, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [`param:${k}`, v])) } });
    const evidence = new EvidenceWriter(runId, this.evidenceRoot, redactor);
    const { gate: policy, policy: doc } = runPolicy({ origins: [origin], ...(this.policyPath ? { path: this.policyPath } : {}) });
    const surface = new PlaywrightSurface({ headless: input.headless ?? true, allowRequest: (u) => policy.allowRequest(u), tracePath: join(evidence.dir, "trace.zip") });
    surface.onPageSwitch((u) => (policy.allowRequest(u) ? "adopt" : "close"));

    const record: RunRecord = {
      id: runId, kind: "discover", capabilityId: input.capabilityId, capabilityVersion: 1, params,
      get status(): RunStatus {
        if (this.finishedAt) return this.discovery?.status === "completed" || this.discovery?.status === "needsReview" ? "completed" : "failed";
        if (!this.session) return "starting";
        if (this.session.state === "human_control") return "human_control";
        if (this.session.state === "paused") return "paused";
        return "running";
      },
      startedAt: new Date().toISOString(), evidenceDir: evidence.dir, evidence, surface, origins: [origin],
      recent: [], session: undefined as unknown as Session,
    };

    // Enforcement layer 2: every lease the session hands out — to the engine or to a human who has
    // taken control — resolves through this wrapper, so replay passes the same allowlist check the
    // model's decisions do. A human is not stopped, only recorded.
    const live: { session?: Session } = {};
    const guarded = new PolicyEnforcedSurface(surface, {
      gate: policy,
      controller: () => live.session?.controller ?? "agent",
      onBlock: (action, reason) => evidence.event({ type: "policy_block", action, reason, controller: "agent" }),
      onOverride: (by, action, reason) => evidence.event({ type: "policy_override", action, reason, by }),
    });
    const session = new Session({
      runId, surface: guarded, evidence, engineController: "agent", capabilityId: input.capabilityId, goal: input.goal,
      ...(input.interventionTimeoutMs ? { interventionTimeoutMs: input.interventionTimeoutMs } : {}),
      onChange: () => this.changed(record),
    });
    record.session = session;
    live.session = session;
    this.runs.set(runId, record);
    evidence.subscribe((e) => {
      record.recent.push(e);
      if (record.recent.length > RECENT_CAP) record.recent.shift();
    });

    const engineSurface = session.start();
    this.changed(record);

    void (async () => {
      try {
        const trace = await runDiscovery({
          goal: input.goal, url: input.url, params, secrets, provider: input.provider,
          surface: engineSurface, policy, evidence,
          maxSteps: input.maxSteps ?? doc.maxSteps,
          approveRisky: async (decision) => session.requestApproval(`${decision.tool}: ${JSON.stringify(decision.args).slice(0, 200)}`),
        });
        record.discovery = { status: trace.status, stepsTaken: trace.steps.length };
      } catch (e) {
        evidence.event({ type: "error", code: "SURFACE_ERROR", message: (e as Error).message });
      } finally {
        record.finishedAt = new Date().toISOString();
        const ok = record.discovery?.status === "completed" || record.discovery?.status === "needsReview";
        session.finish(ok ? "completed" : "aborted");
        await surface.close().catch(() => {});
        this.changed(record);
      }
    })();

    return record;
  }

  /**
   * Arm a fault inside the live run's own browser context, so the *next* thing the running flow does
   * hits it. This is what makes the console's scenario buttons real rather than a re-run with
   * different flags: the operator perturbs a run that is already in flight.
   */
  async injectScenario(runId: string, fault: string, sticky = false): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no such run: ${runId}`);
    if (run.finishedAt) throw new Error(`run ${runId} has already finished`);
    const url = run.origins[0]!;
    // Written through the raw surface, not a leased one: arming a scenario is the harness poking the
    // application, not a controller acting in the flow, and it must work while a human holds control.
    await run.surface.setCookie(url, "cu_fault", fault);
    if (sticky) await run.surface.setCookie(url, "cu_fault_sticky", "1");
  }

  async stopAll(): Promise<void> {
    for (const r of this.runs.values()) {
      r.session.abort();
      await r.surface.close().catch(() => {});
    }
  }
}

/** Read an artifact from disk, for the server's artifact endpoints. */
export function readArtifact(path: string): Capability {
  return JSON.parse(readFileSync(path, "utf8")) as Capability;
}

/**
 * The session: one browser, one run, and exactly one controller at a time.
 *
 * The engine does not know this class exists. It is wired in through the hooks the replay executor
 * and the discovery loop already accept (`onEscalate`, `confirmRisky`, `shouldContinue`), so the
 * automation loops stay unaware of interventions, operators and websockets. What the Session adds
 * is the answer to "who is driving right now", enforced rather than documented.
 */
import { randomUUID } from "node:crypto";
import type { ElementSummary, EscalationReason } from "@cua/schema";
import type { EvidenceWriter } from "../evidence/EvidenceWriter.js";
import type { Surface } from "../surface/types.js";
import { LeasedSurface, type LeaseAuthority } from "./LeasedSurface.js";
import type { Controller, Handoff, HumanAction, InterventionKind, InterventionRequest, Lease, ResumeAt, SessionState } from "./types.js";

export interface SessionOptions {
  runId: string;
  surface: Surface;
  evidence: EvidenceWriter;
  /** Which engine loop is driving. */
  engineController: Extract<Controller, "agent" | "replay">;
  capabilityId?: string;
  goal?: string;
  /** How long an unanswered intervention may stay open. Default 15 minutes. */
  interventionTimeoutMs?: number;
  /** How long a claimed intervention survives its operator disconnecting. Default 60s. */
  disconnectGraceMs?: number;
  onChange?: (session: Session) => void;
}

interface Pending {
  intervention: InterventionRequest;
  resolve: (r: ResumeAt) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

const REASON_TO_KIND: Record<string, InterventionKind> = {
  RISKY_STEP_NEEDS_APPROVAL: "risky_step",
  REPLAY_FAILURE: "replay_failure",
  OUTCOME_ESCALATE: "replay_failure",
  AGENT_GAVE_UP: "agent_gave_up",
  LOOP_DETECTED: "loop_detected",
  MAX_STEPS_REACHED: "agent_gave_up",
  UNKNOWN_STATE: "unknown_state",
  INTERVENTION_TIMEOUT: "unknown_state",
};

export class Session implements LeaseAuthority {
  readonly id: string;
  readonly runId: string;
  private _state: SessionState = "idle";
  private _controller: Controller = "none";
  private _lease: Lease | undefined;
  /** The engine's lease, minted once and restored on every hand-back. */
  private engineLease: Lease | undefined;
  private readonly interventions = new Map<string, InterventionRequest>();
  private pending: Pending | undefined;
  /** Set while a manual pause is in force; resolved by resume(). */
  private manualPause: { promise: Promise<void>; release: () => void } | undefined;
  private readonly humanActions: HumanAction[] = [];
  readonly handoffs: Handoff[] = [];
  private disconnectTimer: NodeJS.Timeout | undefined;
  private aborted = false;

  constructor(private readonly opts: SessionOptions) {
    this.id = `session-${randomUUID().slice(0, 8)}`;
    this.runId = opts.runId;
  }

  get state(): SessionState {
    return this._state;
  }
  get controller(): Controller {
    return this._controller;
  }
  get openInterventions(): InterventionRequest[] {
    return [...this.interventions.values()].filter((i) => i.status === "open" || i.status === "claimed");
  }
  get allInterventions(): InterventionRequest[] {
    return [...this.interventions.values()];
  }
  get actionsByHuman(): readonly HumanAction[] {
    return this.humanActions;
  }

  // ---- LeaseAuthority ----
  currentLeaseId(): string | undefined {
    return this._lease?.id;
  }
  currentController(): Controller {
    return this._controller;
  }
  onViolation(by: Controller, what: string): void {
    this.opts.evidence.event({ type: "error", code: "CONTROL_VIOLATION", message: `${by} attempted ${what} while ${this._controller} holds control` });
  }

  private setState(next: SessionState): void {
    this._state = next;
    this.opts.onChange?.(this);
  }

  /**
   * Issue or restore a lease. Making the current lease id change is what disarms every other
   * `LeasedSurface`, including one captured mid-await.
   *
   * The engine's lease is created once and *restored* on hand-back rather than re-issued, because
   * the engine holds a single surface for the whole run: minting it a new id at every handover would
   * leave its own reference stale and turn the resume into a `CONTROL_VIOLATION`. A human's lease is
   * the opposite — always fresh, so a console that reconnects cannot keep acting with an old one.
   */
  private takeControl(to: Controller, by?: string): LeasedSurface {
    const from = this._controller;
    if (to === this.opts.engineController && this.engineLease) {
      this._lease = this.engineLease;
    } else {
      this._lease = { id: `lease-${randomUUID().slice(0, 8)}`, controller: to, issuedAt: new Date().toISOString() };
      if (to === this.opts.engineController) this.engineLease = this._lease;
    }
    this._controller = to;
    this.opts.evidence.event({ type: "control_change", from, to, ...(by ? { by } : {}), leaseId: this._lease.id });
    this.opts.onChange?.(this);
    return new LeasedSurface(this.opts.surface, this._lease.id, to, this);
  }

  private releaseControl(): void {
    const from = this._controller;
    this._lease = undefined;
    this._controller = "none";
    if (from !== "none") this.opts.evidence.event({ type: "control_change", from, to: "none" });
    this.opts.onChange?.(this);
  }

  /** Hand the engine its surface and mark the run running. Everything the engine does goes through this. */
  start(): LeasedSurface {
    const s = this.takeControl(this.opts.engineController);
    this.setState("running");
    return s;
  }

  /** Hand a human their surface. Only valid from `paused`. */
  claim(interventionId: string, by: string): { surface: LeasedSurface; intervention: InterventionRequest } {
    const iv = this.interventions.get(interventionId);
    if (!iv) throw new Error(`no such intervention: ${interventionId}`);
    if (iv.status === "resolved" || iv.status === "expired") throw new Error(`intervention ${interventionId} is ${iv.status}`);
    if (iv.status === "claimed") throw new Error(`intervention ${interventionId} is already claimed by ${iv.claimedBy}`);
    iv.status = "claimed";
    iv.claimedBy = by;
    iv.claimedAt = new Date().toISOString();
    const surface = this.takeControl("human", by);
    this.setState("human_control");
    return { surface, intervention: iv };
  }

  /**
   * Hand control back. The engine's own `onEscalate` promise resolves with this answer, so the run
   * continues from inside the step it stopped at — the browser was never restarted, and the session,
   * cookies and half-filled forms are exactly as the operator left them.
   */
  resolve(interventionId: string, resumeAt: ResumeAt, by: string, note?: string): void {
    const iv = this.interventions.get(interventionId);
    if (!iv) throw new Error(`no such intervention: ${interventionId}`);
    if (iv.status === "resolved") throw new Error(`intervention ${interventionId} is already resolved`);
    iv.status = "resolved";
    iv.resolvedAt = new Date().toISOString();
    iv.resolution = { resumeAt, by, ...(note ? { note } : {}) };
    // The session is the authority on what the operator answered, so it is the one thing that logs
    // it. The executor used to log a second, identical `resume` for the same decision.
    this.opts.evidence.event({ type: "resume", resumeAt, ...(note ? { note } : {}), ...(iv.stepId ? { stepId: iv.stepId } : {}), by });
    this.persist();

    // A manual pause has no waiting engine promise: the engine is blocked inside shouldContinue,
    // so resolving it means releasing that, not answering an escalation.
    if (iv.kind === "manual_pause") {
      if (resumeAt === "abort") this.aborted = true;
      // shouldContinue re-takes control on the way out, so nothing is done to the lease here. Doing
      // it in both places is how the engine ended up with a lease it could not use.
      this.manualPause?.release();
      this.manualPause = undefined;
      if (this.aborted) this.setState("aborted");
      return;
    }

    const p = this.pending;
    if (p && p.intervention.id === interventionId) {
      clearTimeout(p.timer);
      this.pending = undefined;
      this.handoffs.push({
        interventionId, from: "human", to: resumeAt === "abort" ? "none" : this.opts.engineController,
        startedAt: new Date(p.startedAt).toISOString(), durationMs: Date.now() - p.startedAt,
        actions: this.humanActions.length, resumeAt,
      });
      this.releaseControl();
      if (resumeAt === "abort") {
        this.aborted = true;
        this.setState("aborted");
      } else {
        // The engine reclaims its lease as it resumes; it still holds the surface it was given at
        // start(), so re-issuing under the same controller is what re-arms it.
        this.takeControl(this.opts.engineController);
        this.setState("resuming");
      }
      p.resolve(resumeAt);
    }
  }

  /**
   * Force an intervention with no underlying failure, so an operator can look at a healthy run.
   *
   * A pause is a request to stop at the next safe point, not an immediate seizure of the browser.
   * Control stays with the engine until it reaches its next between-steps check, because taking it
   * away mid-step would leave the engine unable to finish the action it had already started — and,
   * when the pause is raised before the run's first step, unable even to open the page. The state
   * only becomes `paused` when the engine has actually stopped.
   */
  async pause(by = "operator"): Promise<InterventionRequest> {
    if (this.manualPause) throw new Error("already paused");
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.manualPause = { promise, release };
    return this.openIntervention("MANUAL_PAUSE", "manual_pause", undefined, -1, `paused by ${by}`, undefined, { yieldControl: false });
  }

  /** Release a manual pause without an intervention resolution (the operator changed their mind). */
  unpause(): void {
    const iv = this.openInterventions.find((i) => i.kind === "manual_pause");
    if (iv) {
      iv.status = "resolved";
      iv.resolvedAt = new Date().toISOString();
      iv.resolution = { resumeAt: "same", by: "operator" };
    }
    this.manualPause?.release();
    this.manualPause = undefined;
  }

  abort(): void {
    this.aborted = true;
    this.manualPause?.release();
    this.manualPause = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve("abort");
      this.pending = undefined;
    }
    this.setState("aborted");
  }

  finish(state: "completed" | "aborted" = "completed"): void {
    this.releaseControl();
    this.setState(this.aborted ? "aborted" : state);
    this.persist();
  }

  /**
   * The operator's socket dropped while they held control. Keep the lease briefly — a refresh should
   * not lose a half-finished manual fix — then hand the intervention back to the queue.
   */
  operatorDisconnected(): void {
    if (this._state !== "human_control") return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = setTimeout(() => {
      if (this._state !== "human_control") return;
      const iv = this.openInterventions.find((i) => i.status === "claimed");
      if (iv) {
        iv.status = "open";
        delete iv.claimedBy;
      }
      this.releaseControl();
      this.setState("paused");
    }, this.opts.disconnectGraceMs ?? 60_000);
  }

  operatorReconnected(): void {
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
  }

  /** Record what a human did, with the same locator fidelity as an agent action. */
  recordHumanAction(a: HumanAction): void {
    this.humanActions.push(a);
    this.opts.evidence.event({
      type: "human_action", action: a.action,
      ...(a.locator ? { locator: a.locator } : {}), ...(a.value !== undefined ? { value: a.value } : {}),
    });
  }

  // ---- engine hooks ----

  /** Wire into `ReplayOptions.onEscalate` / the discovery loop's escalation hook. */
  readonly onEscalate = async (req: { interventionId: string; reason: EscalationReason; stepId?: string; stepIndex: number; detail: string; screenshot?: string }): Promise<ResumeAt> => {
    return this.await_(await this.openIntervention(req.reason, REASON_TO_KIND[req.reason] ?? "unknown_state", req.stepId, req.stepIndex, req.detail, req.screenshot));
  };

  /** Wire into `ReplayOptions.shouldContinue`. Blocks for as long as a manual pause is in force. */
  readonly shouldContinue = async (): Promise<"continue" | "abort"> => {
    if (this.aborted) return "abort";
    if (this.manualPause) {
      // This is the safe point the pause was waiting for: hand control over now, and take it back
      // when the operator is done.
      this.releaseControl();
      this.setState("paused");
      await this.manualPause.promise;
      if (!this.aborted) {
        this.takeControl(this.opts.engineController);
        this.setState("running");
      }
    }
    return this.aborted ? "abort" : "continue";
  };

  /** Wire into `ReplayOptions.confirmRisky`: a risky step becomes an intervention, not a guess. */
  readonly confirmRisky = async (step: { id: string; intent: string }): Promise<boolean> => {
    const iv = await this.openIntervention("RISKY_STEP_NEEDS_APPROVAL", "risky_step", step.id, -1, step.intent);
    const answer = await this.await_(iv);
    // "same" means the operator approved the engine performing it; "next" means they did it by hand.
    return answer === "same";
  };

  /**
   * A generic approval, for callers whose "risky thing" is not a replay step — the discovery loop
   * asks about a *decision the model just made*, which has no step id yet. The operator's answer
   * means the same thing either way: `same` is "go ahead", anything else is "do not".
   */
  readonly requestApproval = async (what: string, stepId?: string): Promise<boolean> => {
    const iv = await this.openIntervention("RISKY_STEP_NEEDS_APPROVAL", "risky_step", stepId, -1, what);
    return (await this.await_(iv)) === "same";
  };

  private async openIntervention(
    reason: EscalationReason | "MANUAL_PAUSE", kind: InterventionKind,
    stepId: string | undefined, stepIndex: number, detail: string, screenshot?: string,
    { yieldControl = true }: { yieldControl?: boolean } = {},
  ): Promise<InterventionRequest> {
    // Snapshot enough context that the operator never has to read a log to decide.
    let url: string | undefined;
    let elements: ElementSummary[] = [];
    try {
      const obs = await this.opts.surface.observe();
      url = obs.url;
      elements = obs.elements.slice(0, 30);
      if (!screenshot) screenshot = this.opts.evidence.screenshot(`intervention-${stepId?.replace("step:", "") ?? "run"}`, obs.rawScreenshotPng);
    } catch {
      /* a torn-down or dialog-blocked page still deserves an intervention */
    }
    const iv: InterventionRequest = {
      id: `intervention-${randomUUID().slice(0, 8)}`, runId: this.runId, kind, reason,
      ...(this.opts.capabilityId ? { capabilityId: this.opts.capabilityId } : {}),
      ...(this.opts.goal ? { goal: this.opts.goal } : {}),
      ...(stepId ? { stepId } : {}), stepIndex, detail,
      ...(screenshot ? { screenshot } : {}), ...(url ? { url } : {}),
      elements, suggestedActions: ["same", "next", "abort"],
      createdAt: new Date().toISOString(), status: "open",
    };
    this.interventions.set(iv.id, iv);
    if (yieldControl) {
      this.releaseControl();
      this.setState("paused");
    } else {
      // A requested pause: the engine keeps driving until it reaches a safe point. Announce the
      // request so the console can show it immediately, but do not change who is in control.
      this.opts.onChange?.(this);
    }
    this.persist();
    return iv;
  }

  /** Block the engine until the intervention is resolved, or until it expires. */
  private await_(iv: InterventionRequest): Promise<ResumeAt> {
    if (this.aborted) return Promise.resolve("abort");
    return new Promise<ResumeAt>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.intervention.id !== iv.id) return;
        iv.status = "expired";
        this.pending = undefined;
        this.opts.evidence.event({ type: "escalate", interventionId: iv.id, reason: "INTERVENTION_TIMEOUT", detail: `no operator responded within ${Math.round((this.opts.interventionTimeoutMs ?? 900_000) / 1000)}s` });
        this.persist();
        this.setState("aborted");
        resolve("abort");
      }, this.opts.interventionTimeoutMs ?? 900_000);
      // Do not keep the process alive purely to wait for an operator who may never come.
      timer.unref?.();
      this.pending = { intervention: iv, resolve, timer, startedAt: Date.now() };
    });
  }

  private persist(): void {
    try {
      // Redacted like every other artefact of a run. An intervention carries the screen an operator
      // saw — its URL and its accessibility elements — and on this application the member id is in
      // the path. Writing it raw put the one value the whole pipeline avoids straight back on disk.
      this.opts.evidence.json("interventions.json", this.allInterventions);
    } catch {
      /* evidence is best effort; never fail a run over it */
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id, runId: this.runId, state: this._state, controller: this._controller,
      interventions: this.allInterventions, handoffs: this.handoffs, humanActions: this.humanActions.length,
    };
  }
}

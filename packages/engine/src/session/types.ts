/**
 * Session control vocabulary: who is driving, and what a human was asked to do.
 *
 * The one invariant everything here exists to hold: at any instant there is exactly one controller,
 * or none. "The agent paused and a human took over" must never mean "both are clicking".
 */
import type { Controller, ElementSummary, EscalationReason, Locator } from "@cua/schema";

export type { Controller };

/**
 * `paused` and `human_control` are distinct on purpose. A run can be waiting for a person with
 * nobody yet looking at it (an open intervention nobody has claimed), and that is not the same as a
 * person actively holding the browser. The difference decides whether frames are worth streaming
 * and whether a disconnect should hand control back.
 */
export type SessionState = "idle" | "running" | "paused" | "human_control" | "resuming" | "completed" | "aborted";

export type ResumeAt = "same" | "next" | "abort";

export interface Lease {
  id: string;
  controller: Controller;
  issuedAt: string;
}

export type InterventionKind =
  | "risky_step"
  | "replay_failure"
  | "unknown_state"
  | "agent_gave_up"
  | "loop_detected"
  | "manual_pause";

export type InterventionStatus = "open" | "claimed" | "resolved" | "expired";

/**
 * Everything an operator needs to act without reading a log file. Deliberately richer than the
 * engine's own {@link EscalationRequest}: the executor should not know what a console needs.
 */
export interface InterventionRequest {
  id: string;
  runId: string;
  kind: InterventionKind;
  reason: EscalationReason | "MANUAL_PAUSE";
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  stepIndex: number;
  detail: string;
  /** Path relative to the run's evidence directory. */
  screenshot?: string;
  url?: string;
  elements: ElementSummary[];
  suggestedActions: ResumeAt[];
  createdAt: string;
  status: InterventionStatus;
  claimedBy?: string;
  claimedAt?: string;
  resolvedAt?: string;
  resolution?: { resumeAt: ResumeAt; note?: string; by: string };
}

/** What a human did while holding the lease, captured the same way an agent action would be. */
export interface HumanAction {
  at: string;
  action: string;
  locator?: Locator;
  /** Redacted when the field it went into is sensitive. */
  value?: string;
  url?: string;
}

export interface Handoff {
  interventionId: string;
  from: Controller;
  to: Controller;
  startedAt: string;
  durationMs: number;
  actions: number;
  resumeAt?: ResumeAt;
}

/** Thrown when something acts without the current lease. */
export class ControlViolation extends Error {
  constructor(
    readonly attemptedBy: Controller,
    readonly currentController: Controller,
    readonly what: string,
  ) {
    super(`${attemptedBy} attempted ${what} while ${currentController === "none" ? "no one" : currentController} holds control`);
    this.name = "ControlViolation";
  }
}

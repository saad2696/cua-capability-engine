/**
 * Fault injection.
 *
 * A fault is selected by `?fault=<name>` (applies to that request only) or by the cookie
 * `cu_fault=<name>` (one-shot: consumed the first time it fires, unless `cu_fault_sticky=1`).
 * Each fault has a trigger point; a fault that does not apply to the current route is ignored
 * and left armed.
 */
import type { NextFunction, Request, Response } from "express";

export const FAULTS = [
  "not_found",
  "validation",
  "permission_denied",
  "session_expired",
  "unexpected_dialog",
  "slow",
  "server_error",
] as const;
export type Fault = (typeof FAULTS)[number];

export const FAULT_COOKIE = "cu_fault";
export const FAULT_STICKY_COOKIE = "cu_fault_sticky";

export function isFault(v: unknown): v is Fault {
  return typeof v === "string" && (FAULTS as readonly string[]).includes(v);
}

export interface FaultState {
  /** the armed fault, if any */
  fault?: Fault;
  /** where it came from */
  source?: "query" | "cookie";
  sticky: boolean;
}

/** Attach fault state to the request. */
export function faultMiddleware(req: Request, res: Response, next: NextFunction): void {
  const q = req.query["fault"];
  const cookies = req.cookies as Record<string, string | undefined>;
  const state: FaultState = { sticky: cookies[FAULT_STICKY_COOKIE] === "1" };
  if (isFault(q)) {
    state.fault = q;
    state.source = "query";
  } else if (isFault(cookies[FAULT_COOKIE])) {
    state.fault = cookies[FAULT_COOKIE];
    state.source = "cookie";
  }
  res.locals["faults"] = state;
  next();
}

export function faultState(res: Response): FaultState {
  return (res.locals["faults"] as FaultState | undefined) ?? { sticky: false };
}

/**
 * Returns true if `fault` is armed for this request, and consumes it when it came from a
 * one-shot cookie. Call at the trigger point only.
 */
export function fires(res: Response, fault: Fault): boolean {
  const s = faultState(res);
  if (s.fault !== fault) return false;
  if (s.source === "cookie" && !s.sticky) {
    res.clearCookie(FAULT_COOKIE);
    delete s.fault; // do not fire twice in the same request chain
  }
  return true;
}

export function armFault(res: Response, fault: Fault, sticky: boolean): void {
  res.cookie(FAULT_COOKIE, fault, { httpOnly: false, sameSite: "lax" });
  if (sticky) res.cookie(FAULT_STICKY_COOKIE, "1", { httpOnly: false, sameSite: "lax" });
  else res.clearCookie(FAULT_STICKY_COOKIE);
}

export function disarmFaults(res: Response): void {
  res.clearCookie(FAULT_COOKIE);
  res.clearCookie(FAULT_STICKY_COOKIE);
}

export function slowDelayMs(): number {
  const v = Number(process.env["TARGET_FAULT_SLOW_MS"]);
  return Number.isFinite(v) && v >= 0 ? v : 6000;
}

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

export const SESSION_COOKIE = "cu_session";

/** Minimal in-memory session store. Real apps would use a signed cookie; irrelevant for the demo. */
export class SessionStore {
  private sessions = new Map<string, { user: string; createdAt: number }>();

  create(user: string): string {
    const token = randomBytes(16).toString("hex");
    this.sessions.set(token, { user, createdAt: Date.now() });
    return token;
  }

  get(token: string | undefined): { user: string } | undefined {
    return token ? this.sessions.get(token) : undefined;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

export function sessionToken(req: Request): string | undefined {
  return (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax" });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE);
}

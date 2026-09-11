import { Router, type Request, type Response, type NextFunction } from "express";
import type { Account } from "./data/members.js";
import type { MemberStore } from "./data/members.js";
import { armFault, disarmFaults, faultState, fires, isFault, slowDelayMs } from "./faults.js";
import type { SessionStore} from "./session.js";
import { clearSessionCookie, sessionToken, setSessionCookie } from "./session.js";
import { BLOCKING_DIALOG_SCRIPT, UNEXPECTED_DIALOG_SCRIPT, frameset, navFrame } from "./views/layout.js";
import {
  confirmPage, donePage, faultsPage, forbiddenPage, loginPage, memberPage, notFoundPage,
  searchPage, serverErrorPage, stubPage, subAccountFormPage, type SubAccountForm,
} from "./views/pages.js";

export interface AppDeps {
  members: MemberStore;
  sessions: SessionStore;
  credentials: { user: string; password: string };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildRouter(deps: AppDeps): Router {
  const r = Router();

  /** Per-render options: current user plus any injected script from the dialog fault. */
  function pageOpts(req: Request, res: Response): { user?: string; injectScript?: string } {
    const s = deps.sessions.get(sessionToken(req));
    const opts: { user?: string; injectScript?: string } = {};
    if (s) opts.user = s.user;
    if (fires(res, "unexpected_dialog")) opts.injectScript = UNEXPECTED_DIALOG_SCRIPT;
    if (fires(res, "blocking_dialog")) opts.injectScript = BLOCKING_DIALOG_SCRIPT;
    return opts;
  }

  /** Faults that can hit any page: slow (delay) and dialog (handled at render). */
  r.use(async (_req, res, next) => {
    if (fires(res, "slow")) await sleep(slowDelayMs());
    next();
  });

  /** Auth guard for operator pages. Also the trigger point for session_expired and server_error. */
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const token = sessionToken(req);
    if (fires(res, "session_expired")) {
      deps.sessions.destroy(token);
      clearSessionCookie(res);
      res.redirect(302, "/login?expired=1");
      return;
    }
    if (!deps.sessions.get(token)) {
      res.redirect(302, "/login");
      return;
    }
    if (fires(res, "server_error")) {
      res.status(500).send(serverErrorPage(pageOpts(req, res)));
      return;
    }
    next();
  }

  // ---- shell ----
  r.get("/", (_req, res) => { res.type("html").send(frameset()); });
  r.get("/nav", (req, res) => { res.type("html").send(navFrame(Boolean(deps.sessions.get(sessionToken(req))))); });
  r.get("/main", (req, res) => { res.redirect(deps.sessions.get(sessionToken(req)) ? "/search" : "/login"); });
  r.get("/healthz", (_req, res) => { res.json({ ok: true, app: "legacy-cu-core" }); });

  // ---- auth ----
  r.get("/login", (req, res) => {
    const opts = pageOpts(req, res);
    const error = req.query["expired"] === "1" ? "Your session has expired. Please sign in again." : undefined;
    res.type("html").send(loginPage(error ? { ...opts, error } : opts));
  });
  r.post("/login", (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const u = (body["u"] ?? "").trim();
    const p = body["p"] ?? "";
    if (u === deps.credentials.user && p === deps.credentials.password) {
      setSessionCookie(res, deps.sessions.create(u));
      res.redirect(302, "/"); // reload the frameset so the nav frame reflects the signed-in state
      return;
    }
    res.status(401).type("html").send(loginPage({ ...pageOpts(req, res), error: "Invalid user name or password." }));
  });
  r.get("/logout", (req, res) => {
    deps.sessions.destroy(sessionToken(req));
    clearSessionCookie(res);
    res.redirect(302, "/");
  });

  // ---- search ----
  r.get("/search", requireAuth, (req, res) => {
    const opts = pageOpts(req, res);
    const raw = req.query["q"];
    if (typeof raw !== "string") {
      res.type("html").send(searchPage(opts));
      return;
    }
    const q = raw.trim();
    if (q === "") {
      res.type("html").send(searchPage({ ...opts, message: "Please enter a Member ID." }));
      return;
    }
    if (!/^\d{5}$/.test(q)) {
      res.type("html").send(searchPage({ ...opts, query: q, message: "Member ID must be exactly five digits." }));
      return;
    }
    const member = fires(res, "not_found") ? undefined : deps.members.find(q);
    if (!member) {
      res.status(404).type("html").send(notFoundPage({ ...opts, query: q }));
      return;
    }
    res.redirect(302, `/member/${member.id}`);
  });

  // ---- member detail ----
  r.get("/member/:id", requireAuth, (req, res) => {
    const opts = pageOpts(req, res);
    if (fires(res, "permission_denied")) {
      res.status(403).type("html").send(forbiddenPage(opts));
      return;
    }
    const member = deps.members.find(String(req.params["id"]));
    if (!member) {
      res.status(404).type("html").send(notFoundPage({ ...opts, query: String(req.params["id"]) }));
      return;
    }
    res.type("html").send(memberPage({ ...opts, member }));
  });

  // ---- sub-account ----
  function parseForm(body: Record<string, string | undefined>): { form: SubAccountForm; errors: string[]; depositCents: number } {
    const form: SubAccountForm = {
      type: (body["type"] ?? "").trim(),
      nickname: (body["nickname"] ?? "").trim(),
      deposit: (body["deposit"] ?? "").trim(),
      source: (body["source"] ?? "").trim(),
    };
    const errors: string[] = [];
    if (!["Savings", "Christmas Club", "Money Market"].includes(form.type)) errors.push("Select a valid account type.");
    if (form.nickname === "") errors.push("Nickname is required.");
    else if (form.nickname.length > 20) errors.push("Nickname must be 20 characters or fewer.");
    const amount = Number(form.deposit.replace(/[$,]/g, ""));
    const depositCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || form.deposit === "") errors.push("Initial deposit must be a dollar amount.");
    else if (depositCents < 2500) errors.push("Initial deposit must be at least $25.00.");
    return { form, errors, depositCents };
  }

  r.get("/member/:id/subaccount/new", requireAuth, (req, res) => {
    const opts = pageOpts(req, res);
    const member = deps.members.find(String(req.params["id"]));
    if (!member) { res.status(404).type("html").send(notFoundPage({ ...opts, query: String(req.params["id"]) })); return; }
    res.type("html").send(subAccountFormPage({ ...opts, member, form: { type: "Savings" }, errors: [] }));
  });

  r.post("/member/:id/subaccount/new", requireAuth, (req, res) => {
    const opts = pageOpts(req, res);
    const member = deps.members.find(String(req.params["id"]));
    if (!member) { res.status(404).type("html").send(notFoundPage({ ...opts, query: String(req.params["id"]) })); return; }
    const { form, errors, depositCents } = parseForm(req.body as Record<string, string | undefined>);
    if (fires(res, "validation")) errors.push("Funding source account is restricted for transfers. (VAL-2201)");
    if (!member.accounts.some((a) => a.id === form.source)) errors.push("Select a valid funding source.");
    if (errors.length) {
      res.status(422).type("html").send(subAccountFormPage({ ...opts, member, form, errors }));
      return;
    }
    res.type("html").send(confirmPage({ ...opts, member, form, depositCents }));
  });

  r.post("/member/:id/subaccount/open", requireAuth, (req, res) => {
    const opts = pageOpts(req, res);
    const member = deps.members.find(String(req.params["id"]));
    if (!member) { res.status(404).type("html").send(notFoundPage({ ...opts, query: String(req.params["id"]) })); return; }
    const { form, errors, depositCents } = parseForm(req.body as Record<string, string | undefined>);
    if (errors.length || !member.accounts.some((a) => a.id === form.source)) {
      res.status(422).type("html").send(subAccountFormPage({ ...opts, member, form, errors: errors.length ? errors : ["Select a valid funding source."] }));
      return;
    }
    const { account, confirmation } = deps.members.openSubAccount(member.id, {
      type: form.type as Account["type"], nickname: form.nickname, depositCents,
    });
    res.type("html").send(donePage({ ...opts, member, account, confirmation }));
  });

  // ---- stubs the agent might wander into ----
  r.get("/loans", requireAuth, (req, res) => { res.type("html").send(stubPage("Loans", pageOpts(req, res))); });
  r.get("/reports", requireAuth, (req, res) => { res.type("html").send(stubPage("Reports", pageOpts(req, res))); });

  // ---- hidden demo controls ----
  r.get("/__faults", (req, res) => {
    const s = faultState(res);
    const view: { user?: string; armed?: string; sticky: boolean } = { sticky: s.sticky };
    const sess = deps.sessions.get(sessionToken(req));
    if (sess) view.user = sess.user;
    if (s.fault && s.source === "cookie") view.armed = s.fault;
    res.type("html").send(faultsPage(view));
  });
  r.post("/__faults", (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    if (body["clear"] === "1" || !isFault(body["fault"])) disarmFaults(res);
    else armFault(res, body["fault"], body["sticky"] === "1");
    res.redirect(302, "/__faults");
  });
  r.post("/__reset", (_req, res) => { deps.members.reset(); res.json({ ok: true }); });

  return r;
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./server.js";

/** Tiny cookie-jar fetch so tests can follow the session like a browser would. */
class Client {
  private jar = new Map<string, string>();
  constructor(private base: string) {}
  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  private absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const [k, v] = (pair ?? "").split("=");
      if (!k) continue;
      if (v === "" || v === undefined || /Expires=Thu, 01 Jan 1970/.test(raw)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async get(path: string): Promise<Response> {
    const res = await fetch(this.base + path, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  async post(path: string, form: Record<string, string>): Promise<Response> {
    const res = await fetch(this.base + path, {
      method: "POST", redirect: "manual",
      headers: { cookie: this.cookieHeader(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    this.absorb(res);
    return res;
  }
  async login(): Promise<void> {
    const res = await this.post("/login", { u: "demo", p: "demo" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  }
  cookie(name: string): string | undefined { return this.jar.get(name); }
}

let server: Server;
let base: string;
let reset: () => void;

beforeAll(async () => {
  process.env["TARGET_FAULT_SLOW_MS"] = "300";
  const { app, deps } = createApp({ credentials: { user: "demo", password: "demo" } });
  reset = () => deps.members.reset();
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => reset());

describe("shell and auth", () => {
  it("serves a frameset at / with nav and main frames", async () => {
    const html = await (await new Client(base).get("/")).text();
    expect(html).toContain("<frameset");
    expect(html).toContain('name="nav"');
    expect(html).toContain('name="main"');
  });
  it("redirects unauthenticated operator pages to login", async () => {
    const res = await new Client(base).get("/search");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
  it("rejects bad credentials and accepts demo/demo", async () => {
    const c = new Client(base);
    const bad = await c.post("/login", { u: "demo", p: "wrong" });
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Invalid user name or password");
    await c.login();
    expect(c.cookie("cu_session")).toBeTruthy();
  });
  it("login form targets the top window so the frameset reloads", async () => {
    const html = await (await new Client(base).get("/login")).text();
    expect(html).toContain('action="/login" target="_top"');
  });
  it("renders hostile markup: no ids, labels as cells, title attributes", async () => {
    const c = new Client(base); await c.login();
    const html = await (await c.get("/search")).text();
    expect(html).not.toMatch(/\sid="/);
    expect(html).toContain('<td class="c1">Member ID</td>');
    expect(html).toContain('title="Member ID"');
    expect(html).toContain('value="Search"');
  });
});

describe("happy path", () => {
  it("search → detail → sub-account → confirm → done", async () => {
    const c = new Client(base); await c.login();
    const s = await c.get("/search?q=10042");
    expect(s.status).toBe(302);
    expect(s.headers.get("location")).toBe("/member/10042");

    const detail = await (await c.get("/member/10042")).text();
    expect(detail).toContain("Member Detail");
    expect(detail).toContain("Alex");
    expect(detail).toContain("$1,234.56"); // savings balance

    const form = await (await c.get("/member/10042/subaccount/new")).text();
    expect(form).toContain("Open New Sub-Account");

    const review = await c.post("/member/10042/subaccount/new", { type: "Savings", nickname: "Holiday", deposit: "50", source: "10042-01" });
    expect(review.status).toBe(200);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Review and Confirm");
    expect(reviewHtml).toContain("return confirm(");
    expect(reviewHtml).toContain('value="Open Account"');

    const done = await c.post("/member/10042/subaccount/open", { type: "Savings", nickname: "Holiday", deposit: "50", source: "10042-01" });
    const doneHtml = await done.text();
    expect(doneHtml).toContain("Sub-Account Opened");
    expect(doneHtml).toMatch(/CU-\d{6}/);
    expect(doneHtml).toContain("10042-03");
  });
  it("input validation: nickname required, deposit minimum", async () => {
    const c = new Client(base); await c.login();
    const res = await c.post("/member/10042/subaccount/new", { type: "Savings", nickname: "", deposit: "5", source: "10042-01" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Nickname is required.");
    expect(html).toContain("at least $25.00");
  });
  it("search rejects malformed ids and unknown ids", async () => {
    const c = new Client(base); await c.login();
    expect(await (await c.get("/search?q=abc")).text()).toContain("exactly five digits");
    const nf = await c.get("/search?q=99999");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain("No member found");
  });
});

describe("fault injection", () => {
  it("not_found via query fires on a valid member", async () => {
    const c = new Client(base); await c.login();
    const res = await c.get("/search?q=10042&fault=not_found");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No member found");
  });
  it("session_expired via cookie fires once, then re-login works", async () => {
    const c = new Client(base); await c.login();
    await c.post("/__faults", { fault: "session_expired" });
    expect(c.cookie("cu_fault")).toBe("session_expired");
    const first = await c.get("/member/10042");
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/login?expired=1");
    expect(c.cookie("cu_fault")).toBeUndefined(); // consumed
    expect(await (await c.get("/login?expired=1")).text()).toContain("session has expired");
    await c.login();
    expect((await c.get("/member/10042")).status).toBe(200);
  });
  it("sticky fault keeps firing until cleared", async () => {
    const c = new Client(base); await c.login();
    await c.post("/__faults", { fault: "permission_denied", sticky: "1" });
    expect((await c.get("/member/10042")).status).toBe(403);
    expect((await c.get("/member/10042")).status).toBe(403);
    await c.post("/__faults", { clear: "1" });
    expect((await c.get("/member/10042")).status).toBe(200);
  });
  it("validation fault adds a server-side rejection", async () => {
    const c = new Client(base); await c.login();
    const res = await c.post("/member/10042/subaccount/new?fault=validation", { type: "Savings", nickname: "Ok", deposit: "100", source: "10042-01" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("VAL-2201");
  });
  it("unexpected_dialog injects an alert script into the next page", async () => {
    const c = new Client(base); await c.login();
    const html = await (await c.get("/search?fault=unexpected_dialog")).text();
    expect(html).toContain("alert('System maintenance");
  });
  it("server_error returns a 500 page", async () => {
    const c = new Client(base); await c.login();
    const res = await c.get("/search?fault=server_error");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("System Error");
  });
  it("slow delays the response", async () => {
    const c = new Client(base); await c.login();
    const t = Date.now();
    expect((await c.get("/search?fault=slow")).status).toBe(200);
    expect(Date.now() - t).toBeGreaterThanOrEqual(250);
  });
  it("unknown fault names are ignored", async () => {
    const c = new Client(base); await c.login();
    expect((await c.get("/search?fault=bogus")).status).toBe(200);
  });
});

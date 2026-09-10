import { describe, expect, it } from "vitest";
import { createApp } from "./server.js";

describe("target app", () => {
  it("answers health check", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      expect(await res.json()).toEqual({ ok: true, app: "legacy-cu-core" });
    } finally {
      server.close();
    }
  });
});

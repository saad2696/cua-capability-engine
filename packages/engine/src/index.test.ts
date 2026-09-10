import { describe, expect, it } from "vitest";
import { ENGINE_NAME, SCHEMA_VERSION } from "./index.js";

describe("@cua/engine", () => {
  it("re-exports the schema version and names itself", () => {
    expect(ENGINE_NAME).toBe("cua-capability-engine");
    expect(SCHEMA_VERSION).toBe("1.0");
  });
});

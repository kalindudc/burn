import { describe, expect, it } from "vitest";
import { harnessName, harnessOf } from "../../extensions/bb/harnesses.js";

describe("harness table", () => {
  it("reads OpenCode v2 from its database, like the classic OpenCode provider", () => {
    expect(harnessOf("opencode2").reader).toBe("opencode-db");
    expect(harnessOf("acp-opencode").reader).toBe("opencode-db");
    expect(harnessName("opencode2")).toBe("OpenCode v2");
  });

  it("shows tokens instead of list prices for a database that records none", () => {
    expect(harnessOf("opencode2").prices).toBeNull();
  });

  it("leaves an unknown provider on the usage events bb records", () => {
    expect(harnessOf("some-other-provider").reader).toBe("events");
  });
});

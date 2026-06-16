import { describe, expect, it } from "vitest";

import { WarningCollector } from "../warnings.js";

describe("WarningCollector", () => {
  it("records target/reason pairs in insertion order", () => {
    const c = new WarningCollector();
    c.record("pages/userDetail.vue", "dynamic url");
    c.record("composables/useUserApi.ts:fetchUsers", "dynamic method");
    expect(c.warnings).toEqual([
      { target: "pages/userDetail.vue", reason: "dynamic url" },
      { target: "composables/useUserApi.ts:fetchUsers", reason: "dynamic method" },
    ]);
  });

  it("records a parse error with a default reason", () => {
    const c = new WarningCollector();
    c.recordParseError("pages/broken.vue");
    expect(c.warnings).toEqual([{ target: "pages/broken.vue", reason: "syntax error" }]);
  });

  it("records a parse error with detail appended", () => {
    const c = new WarningCollector();
    c.recordParseError("pages/broken.vue", "unexpected token");
    expect(c.warnings).toEqual([
      { target: "pages/broken.vue", reason: "syntax error: unexpected token" },
    ]);
  });

  it("treats empty detail as the default reason", () => {
    const c = new WarningCollector();
    c.recordParseError("pages/broken.vue", "");
    expect(c.warnings[0]?.reason).toBe("syntax error");
  });

  it("returns a defensive copy from the warnings getter", () => {
    const c = new WarningCollector();
    c.record("a", "b");
    const first = c.warnings;
    first.push({ target: "x", reason: "y" });
    expect(c.warnings).toHaveLength(1);
  });
});

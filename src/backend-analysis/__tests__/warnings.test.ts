import { describe, expect, it } from "vitest";

import type { Warning } from "../models.js";
import { WarningCollector } from "../warnings.js";

describe("WarningCollector", () => {
  it("accumulates record() entries as {target, reason}", () => {
    const c = new WarningCollector();
    c.record("routers/items.py:get_dynamic_item", "dynamic path");
    expect(c.warnings).toEqual([
      { target: "routers/items.py:get_dynamic_item", reason: "dynamic path" },
    ]);
  });

  it("records parse errors with a reason", () => {
    const c = new WarningCollector();
    c.recordParseError("routers/broken.py");
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]?.target).toBe("routers/broken.py");
    expect(typeof c.warnings[0]?.reason).toBe("string");
    expect(c.warnings[0]?.reason.length).toBeGreaterThan(0);
  });

  it("includes detail in the parse error reason when provided", () => {
    const c = new WarningCollector();
    c.recordParseError("routers/broken.py", "unexpected token");
    expect(c.warnings[0]?.reason).toContain("unexpected token");
  });

  it("preserves insertion order", () => {
    const c = new WarningCollector();
    c.record("a", "first");
    c.recordParseError("b", "second");
    c.record("c", "third");
    expect(c.warnings.map((w) => w.target)).toEqual(["a", "b", "c"]);
  });

  it("conforms to the models.Warning shape", () => {
    const c = new WarningCollector();
    c.record("x", "y");
    const collected: Warning[] = c.warnings;
    expect(collected).toEqual([{ target: "x", reason: "y" }]);
  });
});

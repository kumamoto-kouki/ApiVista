import { describe, expect, it } from "vitest";

import { makeFileId, makeFunctionId } from "../ids.js";

describe("makeFunctionId", () => {
  it("joins module dotted path and qualname with a colon", () => {
    expect(makeFunctionId("sample_app.routers.items", "get_item")).toBe(
      "sample_app.routers.items:get_item",
    );
  });

  it("preserves Class.method qualnames", () => {
    expect(makeFunctionId("sample_app.routers.items", "ItemRouter.get_item")).toBe(
      "sample_app.routers.items:ItemRouter.get_item",
    );
  });

  it("is deterministic for the same input", () => {
    const a = makeFunctionId("sample_app.routers.items", "get_item");
    const b = makeFunctionId("sample_app.routers.items", "get_item");
    expect(a).toBe(b);
  });
});

describe("makeFileId", () => {
  it("returns a POSIX path relative to backendRoot", () => {
    expect(makeFileId("/x/sample_app", "/x/sample_app/routers/items.py")).toBe("routers/items.py");
  });

  it("returns the bare filename for a file directly under backendRoot", () => {
    expect(makeFileId("/x/sample_app", "/x/sample_app/main.py")).toBe("main.py");
  });

  it("produces POSIX forward slashes for nested files", () => {
    expect(makeFileId("/x/sample_app", "/x/sample_app/a/b/c.py")).toBe("a/b/c.py");
    expect(makeFileId("/x/sample_app", "/x/sample_app/a/b/c.py")).not.toContain("\\");
  });

  it("is deterministic for the same input", () => {
    const a = makeFileId("/x/sample_app", "/x/sample_app/routers/items.py");
    const b = makeFileId("/x/sample_app", "/x/sample_app/routers/items.py");
    expect(a).toBe(b);
  });
});

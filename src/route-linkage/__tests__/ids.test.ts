import { describe, expect, it } from "vitest";

import type { FunctionNode as BackendFunctionNode } from "../../backend-analysis/models.js";
import type { FunctionNode as FrontendFunctionNode } from "../../frontend-analysis/models.js";
import { namespaceFiles, namespaceFunctions, namespaceId } from "../ids.js";

describe("namespaceId", () => {
  it("prefixes a backend id with 'backend:'", () => {
    expect(namespaceId("backend", "routers.items:get_item")).toBe("backend:routers.items:get_item");
  });

  it("prefixes a frontend id with 'frontend:'", () => {
    expect(namespaceId("frontend", "api/items:fetchItem")).toBe("frontend:api/items:fetchItem");
  });

  it("is deterministic for the same input", () => {
    const a = namespaceId("backend", "routers.items:get_item");
    const b = namespaceId("backend", "routers.items:get_item");
    expect(a).toBe(b);
  });
});

describe("namespaceFunctions", () => {
  const backendFns: BackendFunctionNode[] = [
    {
      id: "routers.items:get_item",
      name: "get_item",
      file: "routers/items.py",
      location: { file: "routers/items.py", line: 10 },
      calls: ["routers.items:helper"],
    },
    {
      id: "routers.items:helper",
      name: "helper",
      file: "routers/items.py",
      location: { file: "routers/items.py", line: 20 },
      calls: [],
    },
  ];

  const frontendFns: FrontendFunctionNode[] = [
    {
      id: "api/items:fetchItem",
      name: "fetchItem",
      file: "api/items.ts",
      location: { file: "api/items.ts", line: 5 },
      calls: [],
    },
  ];

  it("namespaces id, side, file and calls for backend nodes", () => {
    const [getItem, helper] = namespaceFunctions("backend", backendFns);
    expect(getItem.id).toBe("backend:routers.items:get_item");
    expect(getItem.side).toBe("backend");
    expect(getItem.file).toBe("backend:routers/items.py");
    expect(getItem.calls).toEqual(["backend:routers.items:helper"]);
    expect(getItem.name).toBe("get_item");
    expect(getItem.location).toEqual({ file: "routers/items.py", line: 10 });
    expect(helper.id).toBe("backend:routers.items:helper");
  });

  it("namespaces frontend nodes with the 'frontend:' prefix", () => {
    const [fetchItem] = namespaceFunctions("frontend", frontendFns);
    expect(fetchItem.id).toBe("frontend:api/items:fetchItem");
    expect(fetchItem.side).toBe("frontend");
    expect(fetchItem.file).toBe("frontend:api/items.ts");
    expect(fetchItem.calls).toEqual([]);
  });

  it("keeps backend and frontend nodes with the same original id unique after namespacing", () => {
    const collidingBackend: BackendFunctionNode[] = [
      { id: "shared:id", name: "a", file: "f.py", location: { file: "f.py", line: 1 }, calls: [] },
    ];
    const collidingFrontend: FrontendFunctionNode[] = [
      { id: "shared:id", name: "b", file: "f.ts", location: { file: "f.ts", line: 1 }, calls: [] },
    ];
    const [be] = namespaceFunctions("backend", collidingBackend);
    const [fe] = namespaceFunctions("frontend", collidingFrontend);
    expect(be.id).not.toBe(fe.id);
    expect(be.id).toBe("backend:shared:id");
    expect(fe.id).toBe("frontend:shared:id");
  });

  it("returns an empty array for an empty input", () => {
    expect(namespaceFunctions("backend", [])).toEqual([]);
  });
});

describe("namespaceFiles", () => {
  it("namespaces id and dependsOn but keeps path unchanged", () => {
    const files = [
      { id: "routers/items.py", path: "routers/items.py", dependsOn: ["models/item.py"] },
      { id: "models/item.py", path: "models/item.py", dependsOn: [] },
    ];
    const [items, models] = namespaceFiles("backend", files);
    expect(items.id).toBe("backend:routers/items.py");
    expect(items.side).toBe("backend");
    expect(items.path).toBe("routers/items.py");
    expect(items.dependsOn).toEqual(["backend:models/item.py"]);
    expect(models.id).toBe("backend:models/item.py");
  });

  it("keeps backend and frontend file ids with the same original id unique after namespacing", () => {
    const be = namespaceFiles("backend", [{ id: "shared.ts", path: "shared.ts", dependsOn: [] }]);
    const fe = namespaceFiles("frontend", [{ id: "shared.ts", path: "shared.ts", dependsOn: [] }]);
    expect(be[0].id).not.toBe(fe[0].id);
  });

  it("returns an empty array for an empty input", () => {
    expect(namespaceFiles("frontend", [])).toEqual([]);
  });
});

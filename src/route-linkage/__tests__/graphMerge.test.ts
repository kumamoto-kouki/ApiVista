import { describe, expect, it } from "vitest";

import type { FunctionNode as BackendFunctionNode } from "../../backend-analysis/models.js";
import type { FunctionNode as FrontendFunctionNode } from "../../frontend-analysis/models.js";
import { mergeFiles, mergeFunctions } from "../graphMerge.js";

describe("mergeFunctions", () => {
  const backendFns: BackendFunctionNode[] = [
    {
      id: "routers.users:get_user",
      name: "get_user",
      file: "routers/users.py",
      location: { file: "routers/users.py", line: 10 },
      calls: ["routers.users:helper"],
    },
    {
      id: "routers.users:helper",
      name: "helper",
      file: "routers/users.py",
      location: { file: "routers/users.py", line: 20 },
      calls: [],
    },
  ];

  const frontendFns: FrontendFunctionNode[] = [
    {
      id: "composables/useUser:fetchUser",
      name: "fetchUser",
      file: "composables/useUser.ts",
      location: { file: "composables/useUser.ts", line: 5 },
      calls: [],
    },
  ];

  it("concatenates both sides with side-namespaced ids", () => {
    const merged = mergeFunctions(backendFns, frontendFns);
    expect(merged).toHaveLength(3);
    expect(merged.map((f) => f.id)).toEqual([
      "backend:routers.users:get_user",
      "backend:routers.users:helper",
      "frontend:composables/useUser:fetchUser",
    ]);
    expect(
      merged.every((f) =>
        f.id.startsWith("backend:") ? f.side === "backend" : f.side === "frontend",
      ),
    ).toBe(true);
  });

  it("threads namespaced call references within the merged array", () => {
    const merged = mergeFunctions(backendFns, frontendFns);
    const getUser = merged.find((f) => f.id === "backend:routers.users:get_user");
    expect(getUser?.calls).toEqual(["backend:routers.users:helper"]);
  });

  it("keeps backend and frontend nodes with the same original id unique in the merged array", () => {
    const collidingBackend: BackendFunctionNode[] = [
      { id: "shared:id", name: "a", file: "f.py", location: { file: "f.py", line: 1 }, calls: [] },
    ];
    const collidingFrontend: FrontendFunctionNode[] = [
      { id: "shared:id", name: "b", file: "f.ts", location: { file: "f.ts", line: 1 }, calls: [] },
    ];
    const merged = mergeFunctions(collidingBackend, collidingFrontend);
    const ids = merged.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["backend:shared:id", "frontend:shared:id"]);
  });

  it("returns an empty array when both sides are empty", () => {
    expect(mergeFunctions([], [])).toEqual([]);
  });
});

describe("mergeFiles", () => {
  it("concatenates both sides with side-namespaced ids and threads dependsOn", () => {
    const backendFiles = [
      { id: "routers/users.py", path: "routers/users.py", dependsOn: ["schemas/user.py"] },
      { id: "schemas/user.py", path: "schemas/user.py", dependsOn: [] },
    ];
    const frontendFiles = [
      { id: "composables/useUser.ts", path: "composables/useUser.ts", dependsOn: [] },
    ];
    const merged = mergeFiles(backendFiles, frontendFiles);
    expect(merged).toHaveLength(3);
    expect(merged.map((f) => f.id)).toEqual([
      "backend:routers/users.py",
      "backend:schemas/user.py",
      "frontend:composables/useUser.ts",
    ]);
    const usersFile = merged.find((f) => f.id === "backend:routers/users.py");
    expect(usersFile?.dependsOn).toEqual(["backend:schemas/user.py"]);
    expect(usersFile?.path).toBe("routers/users.py");
  });

  it("keeps backend and frontend file ids with the same original id unique in the merged array", () => {
    const merged = mergeFiles(
      [{ id: "shared.ts", path: "shared.ts", dependsOn: [] }],
      [{ id: "shared.ts", path: "shared.ts", dependsOn: [] }],
    );
    expect(merged.map((f) => f.id)).toEqual(["backend:shared.ts", "frontend:shared.ts"]);
  });

  it("returns an empty array when both sides are empty", () => {
    expect(mergeFiles([], [])).toEqual([]);
  });
});

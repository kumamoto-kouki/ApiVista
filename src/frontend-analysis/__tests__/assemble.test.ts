import { describe, expect, it } from "vitest";

import { assembleOutput } from "../assemble.js";
import type { ApiCall, FileNode, FunctionNode, Warning } from "../models.js";
import { SCHEMA_VERSION } from "../models.js";

/** 内包ノード id をコンポーネントノード id に揃えたベース固定値（参照貫通の検証用）。 */
const NODE_ID = "pages/users:Users";
const FILE_ID = "pages/users.vue";

function makeApiCall(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    method: "GET",
    urlPattern: "/api/users",
    enclosingFunctionId: NODE_ID,
    location: { file: FILE_ID, line: 3 },
    ...overrides,
  };
}

function makeFunction(overrides: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: NODE_ID,
    name: "Users",
    file: FILE_ID,
    location: { file: FILE_ID, line: 1 },
    calls: [],
    ...overrides,
  };
}

describe("assembleOutput", () => {
  it("pins schemaVersion to 1", () => {
    const out = assembleOutput([], [], [], []);

    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.schemaVersion).toBe(1);
  });

  it("passes apiCalls/functions/files/warnings through unchanged (same references)", () => {
    const apiCalls: ApiCall[] = [makeApiCall()];
    const functions: FunctionNode[] = [makeFunction()];
    const files: FileNode[] = [{ id: FILE_ID, path: FILE_ID, dependsOn: [] }];
    const warnings: Warning[] = [{ target: "pages/broken.vue", reason: "syntax error" }];

    const out = assembleOutput(apiCalls, functions, files, warnings);

    expect(out.apiCalls).toBe(apiCalls);
    expect(out.functions).toBe(functions);
    expect(out.files).toBe(files);
    expect(out.warnings).toBe(warnings);
  });

  it("preserves input order of apiCalls/functions/files", () => {
    const a = makeApiCall({ urlPattern: "/a" });
    const b = makeApiCall({ urlPattern: "/b" });
    const c = makeApiCall({ urlPattern: "/c" });

    const out = assembleOutput([a, b, c], [], [], []);

    expect(out.apiCalls.map((x) => x.urlPattern)).toEqual(["/a", "/b", "/c"]);
  });

  it("resolves ApiCall.enclosingFunctionId -> FunctionNode.id -> FileNode.id reference pass-through (Req 3.2/3.3)", () => {
    const apiCall = makeApiCall();
    const fn = makeFunction();
    const files: FileNode[] = [{ id: FILE_ID, path: FILE_ID, dependsOn: [] }];

    const out = assembleOutput([apiCall], [fn], files, []);

    // ApiCall -> FunctionNode（enclosingFunctionId == id）
    const enclosing = out.functions.find((f) => f.id === out.apiCalls[0]?.enclosingFunctionId);
    expect(enclosing).toBeDefined();

    // FunctionNode -> FileNode（file == id）
    const file = out.files.find((f) => f.id === enclosing?.file);
    expect(file).toBeDefined();
    expect(file?.path).toBe(FILE_ID);
  });

  it("keeps calls[]/dependsOn[] edges referencing existing ids (Req 3.2)", () => {
    const calleeId = "composables/useUserApi:fetchUsers";
    const calleeFileId = "composables/useUserApi.ts";

    const caller = makeFunction({ calls: [calleeId] });
    const callee = makeFunction({
      id: calleeId,
      name: "fetchUsers",
      file: calleeFileId,
      location: { file: calleeFileId, line: 2 },
    });
    const files: FileNode[] = [
      { id: FILE_ID, path: FILE_ID, dependsOn: [calleeFileId] },
      { id: calleeFileId, path: calleeFileId, dependsOn: [] },
    ];

    const out = assembleOutput([], [caller, callee], files, []);

    for (const fn of out.functions) {
      for (const edge of fn.calls) {
        expect(out.functions.some((f) => f.id === edge)).toBe(true);
      }
    }
    for (const file of out.files) {
      for (const dep of file.dependsOn) {
        expect(out.files.some((f) => f.id === dep)).toBe(true);
      }
    }
  });

  it("does not mutate input arrays or objects", () => {
    const apiCall = makeApiCall();
    const fn = makeFunction();
    const apiCalls = [apiCall];
    const functions = [fn];

    assembleOutput(apiCalls, functions, [], []);

    expect(apiCalls).toEqual([apiCall]);
    expect(functions).toEqual([fn]);
    expect(apiCall.enclosingFunctionId).toBe(NODE_ID);
  });

  it("produces a structurally valid AnalysisOutput (backend-symmetric shape)", () => {
    const out = assembleOutput([makeApiCall()], [makeFunction()], [], []);

    expect(Object.keys(out).sort()).toEqual(
      ["apiCalls", "files", "functions", "schemaVersion", "warnings"].sort(),
    );
  });
});

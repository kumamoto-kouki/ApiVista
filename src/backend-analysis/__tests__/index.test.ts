import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { analyzeBackend } from "../index.js";
import type { AnalysisOutput, RouteDefinition } from "../index.js";
import { resetPythonParser } from "../parser.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

function findRoute(
  output: AnalysisOutput,
  method: string,
  path: string,
): RouteDefinition | undefined {
  return output.routes.find((r) => r.method === method && r.path === path);
}

describe("analyzeBackend", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("returns a single AnalysisOutput with schemaVersion 1 (no external runtime needed)", async () => {
    // The mere fact that this runs under Node + vitest with only the WASM
    // grammar (no Python/uv) demonstrates Requirement 6.4.
    const output = await analyzeBackend(SAMPLE_APP);
    expect(output.schemaVersion).toBe(1);
    expect(Array.isArray(output.routes)).toBe(true);
    expect(Array.isArray(output.functions)).toBe(true);
    expect(Array.isArray(output.files)).toBe(true);
    expect(Array.isArray(output.warnings)).toBe(true);
  });

  it("resolves all statically-resolvable routes with correct entryFunctionIds", async () => {
    const output = await analyzeBackend(SAMPLE_APP);

    const getItem = findRoute(output, "GET", "/api/items/{item_id}");
    const postItem = findRoute(output, "POST", "/api/items");
    const getUser = findRoute(output, "GET", "/users/{user_id}");
    const postUser = findRoute(output, "POST", "/users");

    expect(getItem?.entryFunctionId).toBe("sample_app.routers.items:get_item");
    expect(postItem?.entryFunctionId).toBe("sample_app.routers.items:create_item");
    expect(getUser?.entryFunctionId).toBe("sample_app.routers.users:get_user");
    expect(postUser?.entryFunctionId).toBe("sample_app.routers.users:create_user");

    // The dynamic (non-literal) route must be excluded from results (Req 5.2).
    expect(output.routes.some((r) => r.entryFunctionId.endsWith(":get_dynamic_item"))).toBe(false);
  });

  it("keeps cross-reference integrity: route -> function -> file (Req 4.2)", async () => {
    const output = await analyzeBackend(SAMPLE_APP);
    const functionIds = new Set(output.functions.map((f) => f.id));
    const fileIds = new Set(output.files.map((f) => f.id));

    expect(output.routes.length).toBeGreaterThan(0);
    for (const route of output.routes) {
      expect(functionIds.has(route.entryFunctionId)).toBe(true);
      const fn = output.functions.find((f) => f.id === route.entryFunctionId);
      expect(fn).toBeDefined();
      expect(fileIds.has(fn?.file ?? "")).toBe(true);
    }
  });

  it("merges schema references for each handler with correct classNames/roles", async () => {
    const output = await analyzeBackend(SAMPLE_APP);

    const byEntry = (id: string): RouteDefinition | undefined =>
      output.routes.find((r) => r.entryFunctionId === id);

    const getItem = byEntry("sample_app.routers.items:get_item");
    const createItem = byEntry("sample_app.routers.items:create_item");
    const getUser = byEntry("sample_app.routers.users:get_user");
    const createUser = byEntry("sample_app.routers.users:create_user");

    expect(getItem?.schemaRefs.length).toBeGreaterThan(0);
    expect(createItem?.schemaRefs.length).toBeGreaterThan(0);
    expect(getUser?.schemaRefs.length).toBeGreaterThan(0);
    expect(createUser?.schemaRefs.length).toBeGreaterThan(0);

    // get_item: response ItemResponse (local model).
    expect(
      getItem?.schemaRefs.some((s) => s.className === "ItemResponse" && s.role === "response"),
    ).toBe(true);
    // create_item: request ItemCreate + response ItemResponse.
    expect(
      createItem?.schemaRefs.some((s) => s.className === "ItemCreate" && s.role === "request"),
    ).toBe(true);
    expect(
      createItem?.schemaRefs.some((s) => s.className === "ItemResponse" && s.role === "response"),
    ).toBe(true);
    // get_user / create_user: cross-file models from schemas.py.
    expect(
      getUser?.schemaRefs.some((s) => s.className === "UserResponse" && s.role === "response"),
    ).toBe(true);
    expect(
      createUser?.schemaRefs.some((s) => s.className === "UserRequest" && s.role === "request"),
    ).toBe(true);
  });

  it("records warnings for broken.py (syntax error) and the dynamic route", async () => {
    const output = await analyzeBackend(SAMPLE_APP);

    expect(output.warnings.some((w) => w.target === "routers/broken.py")).toBe(true);
    expect(output.warnings.some((w) => w.target.endsWith(":get_dynamic_item"))).toBe(true);
  });

  it("is deterministic across invocations", async () => {
    const a = await analyzeBackend(SAMPLE_APP);
    resetPythonParser();
    const b = await analyzeBackend(SAMPLE_APP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("rejects when backendRoot does not exist", async () => {
    await expect(analyzeBackend("/nonexistent/path/does/not/exist")).rejects.toThrow();
  });

  it("rejects when backendRoot is a file, not a directory", async () => {
    const filePath = join(tmpdir(), `analyze-backend-not-a-dir-${String(Date.now())}.py`);
    writeFileSync(filePath, "x = 1\n", "utf8");
    await expect(analyzeBackend(filePath)).rejects.toThrow();
  });
});

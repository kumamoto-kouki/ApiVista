import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractRouterRelations } from "../extractors/routers.js";
import { getPythonParser, resetPythonParser } from "../parser.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

async function parse(source: string): Promise<Tree> {
  const parser = await getPythonParser();
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("parse returned null");
  }
  return tree;
}

function parseFixture(relPath: string): Promise<Tree> {
  const source = readFileSync(join(SAMPLE_APP, relPath), "utf8");
  return parse(source);
}

describe("extractRouterRelations", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("extracts the FastAPI instance and include_router calls from main.py (Req 1.2)", async () => {
    const tree = await parseFixture("main.py");
    const result = extractRouterRelations(tree, "main.py");

    // No APIRouter definitions in main.py.
    expect(result.routers).toHaveLength(0);

    // Exactly one FastAPI() instance -> BFS-origin candidate.
    expect(result.fastapiInstances).toHaveLength(1);
    const app = result.fastapiInstances[0];
    expect(app?.variableName).toBe("app");
    // `app = FastAPI(...)` is on line 12 of the fixture.
    expect(app?.location).toEqual({ file: "main.py", line: 12 });

    // Two include_router calls: items (prefix "/api") and users (no prefix).
    expect(result.includeRouterCalls).toHaveLength(2);

    const items = result.includeRouterCalls.find((c) => c.routerExpr === "items.router");
    expect(items).toBeDefined();
    expect(items?.targetName).toBe("app");
    expect(items?.prefix).toBe("/api");
    expect(items?.location.line).toBeGreaterThan(0);

    const users = result.includeRouterCalls.find((c) => c.routerExpr === "users.router");
    expect(users).toBeDefined();
    expect(users?.targetName).toBe("app");
    expect(users?.prefix).toBe("");
    expect(users?.location.line).toBeGreaterThan(0);
  });

  it("extracts the APIRouter definition with prefix from routers/items.py (Req 1.3)", async () => {
    const tree = await parseFixture("routers/items.py");
    const result = extractRouterRelations(tree, "routers/items.py");

    expect(result.fastapiInstances).toHaveLength(0);
    expect(result.includeRouterCalls).toHaveLength(0);

    expect(result.routers).toHaveLength(1);
    const router = result.routers[0];
    expect(router?.variableName).toBe("router");
    expect(router?.prefix).toBe("/items");
    // `router = APIRouter(prefix="/items")` is on line 18 of the fixture.
    expect(router?.location).toEqual({ file: "routers/items.py", line: 18 });
  });

  it("extracts the APIRouter definition with prefix from routers/users.py (Req 1.3)", async () => {
    const tree = await parseFixture("routers/users.py");
    const result = extractRouterRelations(tree, "routers/users.py");

    expect(result.routers).toHaveLength(1);
    const router = result.routers[0];
    expect(router?.variableName).toBe("router");
    expect(router?.prefix).toBe("/users");
    expect(router?.location.line).toBeGreaterThan(0);
  });

  it("defaults prefix to '' when APIRouter has no prefix kwarg or a non-literal prefix", async () => {
    const source = [
      "from fastapi import APIRouter",
      "",
      "bare = APIRouter()",
      "dynamic = APIRouter(prefix=PREFIX)",
      'literal = APIRouter(prefix="/lit")',
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractRouterRelations(tree, "mod.py");

    const bare = result.routers.find((r) => r.variableName === "bare");
    expect(bare?.prefix).toBe("");

    const dynamic = result.routers.find((r) => r.variableName === "dynamic");
    expect(dynamic?.prefix).toBe("");

    const literal = result.routers.find((r) => r.variableName === "literal");
    expect(literal?.prefix).toBe("/lit");
  });

  it("preserves the dotted routerExpr text of include_router's first positional arg", async () => {
    const source = [
      "router = object()",
      'app.include_router(deeply.nested.router, prefix="/deep")',
      "app.include_router(local_router)",
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractRouterRelations(tree, "mod.py");

    const deep = result.includeRouterCalls.find((c) => c.routerExpr === "deeply.nested.router");
    expect(deep).toBeDefined();
    expect(deep?.targetName).toBe("app");
    expect(deep?.prefix).toBe("/deep");

    const local = result.includeRouterCalls.find((c) => c.routerExpr === "local_router");
    expect(local).toBeDefined();
    expect(local?.prefix).toBe("");
  });
});

describe("extractRouterRelations — f-string / 定数 prefix の畳み込み", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("f-string prefix を同一ファイルのモジュール定数で畳み込む", async () => {
    const source = [
      "from fastapi import FastAPI",
      'API_PREFIX = "/v1"',
      "app = FastAPI()",
      'app.include_router(device_router, prefix=f"{API_PREFIX}/devices")',
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractRouterRelations(tree, "main.py");

    const call = result.includeRouterCalls.find((c) => c.routerExpr === "device_router");
    expect(call).toBeDefined();
    expect(call?.prefix).toBe("/v1/devices");
  });

  it("素の識別子 prefix（prefix=API_PREFIX）も定数で解決する", async () => {
    const source = [
      "from fastapi import FastAPI",
      'API_PREFIX = "/v1"',
      "app = FastAPI()",
      "app.include_router(r, prefix=API_PREFIX)",
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractRouterRelations(tree, "main.py");
    expect(result.includeRouterCalls[0]?.prefix).toBe("/v1");
  });

  it("解決できない補間（未知の変数）は静的決定不能として空 prefix", async () => {
    const source = [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      'app.include_router(r, prefix=f"{UNKNOWN}/devices")',
      "",
    ].join("\n");
    const tree = await parse(source);
    const result = extractRouterRelations(tree, "main.py");
    expect(result.includeRouterCalls[0]?.prefix).toBe("");
  });
});

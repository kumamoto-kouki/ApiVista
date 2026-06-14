import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractRoutes } from "../extractors/routes.js";
import type { RouteCandidate } from "../extractors/routes.js";
import { getPythonParser, resetPythonParser } from "../parser.js";
import { WarningCollector } from "../warnings.js";

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

function byHandler(routes: RouteCandidate[], handlerName: string): RouteCandidate | undefined {
  return routes.find((route) => route.handlerName === handlerName);
}

describe("extractRoutes", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("extracts literal-path route decorators from routers/items.py (Req 1.1)", async () => {
    const tree = await parseFixture("routers/items.py");
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "routers/items.py", collector);

    const getItem = byHandler(routes, "get_item");
    expect(getItem).toBeDefined();
    expect(getItem?.method).toBe("GET");
    expect(getItem?.path).toBe("/{item_id}");
    expect(getItem?.handlerName).toBe("get_item");
    expect(getItem?.qualname).toBe("get_item");
    // `def get_item` is on line 41 of the fixture.
    expect(getItem?.location).toEqual({ file: "routers/items.py", line: 41 });

    const createItem = byHandler(routes, "create_item");
    expect(createItem).toBeDefined();
    expect(createItem?.method).toBe("POST");
    expect(createItem?.path).toBe("");
    expect(createItem?.qualname).toBe("create_item");
  });

  it("excludes a non-string-literal path route and warns it as unresolved (Req 5.2/5.3)", async () => {
    const tree = await parseFixture("routers/items.py");
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "routers/items.py", collector);

    // @router.get(DYNAMIC_SEGMENT) -> path is a variable, not a string literal.
    expect(byHandler(routes, "get_dynamic_item")).toBeUndefined();

    const warning = collector.warnings.find((w) => w.target.includes("get_dynamic_item"));
    expect(warning).toBeDefined();
    expect(warning?.target).toBe("routers/items.py:get_dynamic_item");
    expect(warning?.reason.toLowerCase()).toMatch(/static|unresolved|resolve/);
  });

  it("only emits the two literal-path routes for items.py (dynamic one excluded)", async () => {
    const tree = await parseFixture("routers/items.py");
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "routers/items.py", collector);

    expect(routes.map((r) => r.handlerName).sort()).toEqual(["create_item", "get_item"]);
  });

  it("extracts route decorators from routers/users.py (Req 1.1)", async () => {
    const tree = await parseFixture("routers/users.py");
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "routers/users.py", collector);

    const getUser = byHandler(routes, "get_user");
    expect(getUser?.method).toBe("GET");
    expect(getUser?.path).toBe("/{user_id}");

    const createUser = byHandler(routes, "create_user");
    expect(createUser?.method).toBe("POST");
    expect(createUser?.path).toBe("");

    expect(collector.warnings).toHaveLength(0);
  });

  it("ignores programmatic registration and non-HTTP-method decorators (Req 1.4)", async () => {
    const source = [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      '@app.add_api_route("/x", endpoint)',
      "def handler_x():",
      "    return {}",
      "",
      "@staticmethod",
      "def helper_static():",
      "    return {}",
      "",
      "@property",
      "def helper_prop(self):",
      "    return self._x",
      "",
      '@app.websocket("/ws")',
      "def ws_handler():",
      "    return {}",
      "",
    ].join("\n");
    const tree = await parse(source);
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "main.py", collector);

    expect(routes).toHaveLength(0);
    // No HTTP-method route candidates, so no unresolved-path warnings either.
    expect(collector.warnings).toHaveLength(0);
  });

  it("supports async handlers and all HTTP methods (Req 1.1)", async () => {
    const source = [
      "router = object()",
      "",
      '@router.put("/a")',
      "async def put_handler():",
      "    return {}",
      "",
      '@router.delete("/b")',
      "def delete_handler():",
      "    return {}",
      "",
      '@router.patch("/c")',
      "def patch_handler():",
      "    return {}",
      "",
    ].join("\n");
    const tree = await parse(source);
    const collector = new WarningCollector();
    const routes = extractRoutes(tree, "mod.py", collector);

    expect(byHandler(routes, "put_handler")?.method).toBe("PUT");
    expect(byHandler(routes, "delete_handler")?.method).toBe("DELETE");
    expect(byHandler(routes, "patch_handler")?.method).toBe("PATCH");
    expect(byHandler(routes, "put_handler")?.path).toBe("/a");
  });
});

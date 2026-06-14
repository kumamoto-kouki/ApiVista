import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractFile } from "../extractFile.js";
import { getPythonParser, resetPythonParser } from "../parser.js";
import { WarningCollector } from "../warnings.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

async function parseFixture(relPath: string): Promise<Tree> {
  const source = readFileSync(join(SAMPLE_APP, relPath), "utf8");
  const parser = await getPythonParser();
  const tree = parser.parse(source);
  if (tree === null) {
    throw new Error("parse returned null");
  }
  return tree;
}

describe("extractFile", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("composes all Pass1 extractor results for routers/items.py (Req 1.1, 2.1, 3.1)", async () => {
    const tree = await parseFixture("routers/items.py");
    const collector = new WarningCollector();
    const result = extractFile("routers/items.py", tree, collector);

    expect(result.fileId).toBe("routers/items.py");
    expect(result.skipped).toBe(false);

    // routes: get_item + create_item (dynamic one excluded -> warned).
    expect(result.routes.map((r) => r.handlerName).sort()).toEqual(["create_item", "get_item"]);
    const getItem = result.routes.find((r) => r.handlerName === "get_item");
    expect(getItem?.method).toBe("GET");
    expect(getItem?.path).toBe("/{item_id}");

    // routers: router = APIRouter(prefix="/items").
    const router = result.routers.find((r) => r.variableName === "router");
    expect(router).toBeDefined();
    expect(router?.prefix).toBe("/items");

    // schema ref candidates: at least ItemCreate (request) / ItemResponse (response).
    expect(result.schemaRefCandidates.length).toBeGreaterThan(0);
    expect(result.schemaRefCandidates.map((c) => c.className)).toEqual(
      expect.arrayContaining(["ItemCreate", "ItemResponse"]),
    );

    // class definitions registry: ItemCreate / ItemResponse.
    expect(result.classDefinitions.map((c) => c.className).sort()).toEqual([
      "ItemCreate",
      "ItemResponse",
    ]);

    // function definitions registry includes the handlers.
    expect(result.functionDefinitions.map((f) => f.name)).toEqual(
      expect.arrayContaining(["get_item", "create_item"]),
    );

    // call expressions include the format_item_label helper call.
    expect(result.callExpressions.map((c) => c.calleeName)).toContain("format_item_label");

    // unresolved dynamic route was warned.
    const warning = collector.warnings.find((w) => w.target.includes("get_dynamic_item"));
    expect(warning).toBeDefined();
  });

  it("composes FastAPI instances and include_router calls for main.py (Req 1.1)", async () => {
    const tree = await parseFixture("main.py");
    const collector = new WarningCollector();
    const result = extractFile("main.py", tree, collector);

    expect(result.skipped).toBe(false);

    const app = result.fastapiInstances.find((i) => i.variableName === "app");
    expect(app).toBeDefined();

    expect(result.includeRouterCalls).toHaveLength(2);
    expect(result.includeRouterCalls.map((c) => c.routerExpr).sort()).toEqual([
      "items.router",
      "users.router",
    ]);
  });

  it("skips a syntactically broken file and records a parse-error warning (Req 5.1)", async () => {
    const tree = await parseFixture("routers/broken.py");
    const collector = new WarningCollector();
    const result = extractFile("routers/broken.py", tree, collector);

    expect(result.skipped).toBe(true);
    expect(result.fileId).toBe("routers/broken.py");
    expect(result.routes).toEqual([]);
    expect(result.routers).toEqual([]);
    expect(result.fastapiInstances).toEqual([]);
    expect(result.includeRouterCalls).toEqual([]);
    expect(result.schemaRefCandidates).toEqual([]);
    expect(result.classDefinitions).toEqual([]);
    expect(result.functionDefinitions).toEqual([]);
    expect(result.callExpressions).toEqual([]);

    const parseError = collector.warnings.find((w) => w.target === "routers/broken.py");
    expect(parseError).toBeDefined();
    expect(parseError?.reason.toLowerCase()).toContain("syntax error");
  });

  it("accumulates warnings across files into a shared collector (Req 5.1, 5.2, 5.3)", async () => {
    const collector = new WarningCollector();

    const brokenTree = await parseFixture("routers/broken.py");
    extractFile("routers/broken.py", brokenTree, collector);

    const itemsTree = await parseFixture("routers/items.py");
    extractFile("routers/items.py", itemsTree, collector);

    // broken.py parse error AND items.py dynamic-route warning both present.
    expect(collector.warnings.some((w) => w.target === "routers/broken.py")).toBe(true);
    expect(collector.warnings.some((w) => w.target.includes("get_dynamic_item"))).toBe(true);
  });
});

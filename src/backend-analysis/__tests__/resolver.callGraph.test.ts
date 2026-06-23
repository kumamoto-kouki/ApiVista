import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractFile } from "../extractFile.js";
import type { FileExtractionResult, RouteCandidate } from "../extractFile.js";
import type { ModuleMap } from "../moduleMap.js";
import { getPythonParser, resetPythonParser } from "../parser.js";
import { buildCallGraph, deriveFileGraph } from "../resolver/callGraph.js";
import type { Binding } from "../symbolTable.js";
import { buildSymbolTable } from "../symbolTable.js";
import { WarningCollector } from "../warnings.js";

const here = dirname(fileURLToPath(import.meta.url));
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

/** Module map mirroring sample_app for the relevant files. */
function sampleModuleMap(): ModuleMap {
  const moduleToPath = new Map<string, string>([
    ["sample_app", "__init__.py"],
    ["sample_app.main", "main.py"],
    ["sample_app.helpers", "helpers.py"],
    ["sample_app.schemas", "schemas.py"],
    ["sample_app.routers", "routers/__init__.py"],
    ["sample_app.routers.items", "routers/items.py"],
    ["sample_app.routers.users", "routers/users.py"],
  ]);
  const pathToModule = new Map<string, string>();
  for (const [m, p] of moduleToPath) {
    pathToModule.set(p, m);
  }
  return { moduleToPath, pathToModule, exportedNames: new Map(), parsedFiles: new Map() };
}

async function buildSample(): Promise<{
  perFile: Map<string, FileExtractionResult>;
  symbolTables: Map<string, Map<string, Binding>>;
  entryHandlers: RouteCandidate[];
}> {
  const collector = new WarningCollector();
  const perFile = new Map<string, FileExtractionResult>();
  const symbolTables = new Map<string, Map<string, Binding>>();
  const files: [string, string][] = [
    ["main.py", "main.py"],
    ["helpers.py", "helpers.py"],
    ["routers/items.py", "routers/items.py"],
    ["routers/users.py", "routers/users.py"],
  ];
  for (const [rel, fileId] of files) {
    const tree = await parseFixture(rel);
    perFile.set(fileId, extractFile(fileId, tree, collector));
    symbolTables.set(fileId, buildSymbolTable(tree, fileId));
  }
  const entryHandlers: RouteCandidate[] = [
    ...(perFile.get("routers/items.py")?.routes ?? []),
    ...(perFile.get("routers/users.py")?.routes ?? []),
  ];
  return { perFile, symbolTables, entryHandlers };
}

describe("buildCallGraph", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("builds function nodes for handlers and the cross-file helper (Req 3.1)", async () => {
    const { perFile, symbolTables, entryHandlers } = await buildSample();
    const map = sampleModuleMap();

    const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
    const byId = new Map(functions.map((f) => [f.id, f]));

    expect(byId.has("sample_app.routers.items:get_item")).toBe(true);
    expect(byId.has("sample_app.routers.items:create_item")).toBe(true);
    expect(byId.has("sample_app.routers.users:get_user")).toBe(true);
    expect(byId.has("sample_app.routers.users:create_user")).toBe(true);
    expect(byId.has("sample_app.helpers:format_item_label")).toBe(true);

    const getItem = byId.get("sample_app.routers.items:get_item");
    expect(getItem?.name).toBe("get_item");
    expect(getItem?.file).toBe("routers/items.py");
    expect(getItem?.location.file).toBe("routers/items.py");
  });

  it("resolves the cross-file helper call as an edge (Req 3.1)", async () => {
    const { perFile, symbolTables, entryHandlers } = await buildSample();
    const map = sampleModuleMap();

    const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
    const byId = new Map(functions.map((f) => [f.id, f]));

    expect(byId.get("sample_app.routers.items:get_item")?.calls).toContain(
      "sample_app.helpers:format_item_label",
    );
    expect(byId.get("sample_app.routers.items:create_item")?.calls).toContain(
      "sample_app.helpers:format_item_label",
    );
  });

  it("treats external/constructor calls as terminal (Req 3.3)", async () => {
    const { perFile, symbolTables, entryHandlers } = await buildSample();
    const map = sampleModuleMap();

    const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
    const byId = new Map(functions.map((f) => [f.id, f]));

    // ItemResponse(...) constructor and format(...) builtins are not backend functions.
    const getItem = byId.get("sample_app.routers.items:get_item");
    expect(getItem?.calls).toEqual(["sample_app.helpers:format_item_label"]);

    // format_item_label only calls json.dumps (stdlib) -> terminal, no internal calls.
    const helper = byId.get("sample_app.helpers:format_item_label");
    expect(helper?.calls).toEqual([]);

    // No external symbol leaked in as a node.
    expect(byId.has("json:dumps")).toBe(false);
    expect(functions.some((f) => f.id.startsWith("fastapi"))).toBe(false);
  });

  it("visits each function once under mutual recursion (cycle-safe)", async () => {
    const collector = new WarningCollector();
    const source = ["def a():", "    b()", "", "def b():", "    a()", ""].join("\n");
    const parser = await getPythonParser();
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error("parse returned null");
    }
    const fileId = "cycle.py";
    const perFile = new Map<string, FileExtractionResult>([
      [fileId, extractFile(fileId, tree, collector)],
    ]);
    const symbolTables = new Map<string, Map<string, Binding>>([
      [fileId, buildSymbolTable(tree, fileId)],
    ]);
    const map: ModuleMap = {
      moduleToPath: new Map([["pkg.cycle", "cycle.py"]]),
      pathToModule: new Map([["cycle.py", "pkg.cycle"]]),
      exportedNames: new Map(),
      parsedFiles: new Map(),
    };
    const fnA = perFile.get(fileId)?.functionDefinitions.find((d) => d.name === "a");
    if (fnA === undefined) {
      throw new Error("expected function a");
    }
    const entry: RouteCandidate = {
      method: "GET",
      path: "/",
      handlerName: "a",
      qualname: fnA.qualname,
      location: fnA.location,
    };

    const functions = buildCallGraph([entry], perFile, map, symbolTables);
    const byId = new Map(functions.map((f) => [f.id, f]));

    // Both visited exactly once; mutual edges present; no infinite loop.
    expect(functions.filter((f) => f.id === "pkg.cycle:a")).toHaveLength(1);
    expect(functions.filter((f) => f.id === "pkg.cycle:b")).toHaveLength(1);
    expect(byId.get("pkg.cycle:a")?.calls).toEqual(["pkg.cycle:b"]);
    expect(byId.get("pkg.cycle:b")?.calls).toEqual(["pkg.cycle:a"]);
  });
});

describe("deriveFileGraph", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("derives file dependencies from the function graph (Req 3.2)", async () => {
    const { perFile, symbolTables, entryHandlers } = await buildSample();
    const map = sampleModuleMap();

    const functions = buildCallGraph(entryHandlers, perFile, map, symbolTables);
    const files = deriveFileGraph(functions);
    const byPath = new Map(files.map((f) => [f.path, f]));

    const items = byPath.get("routers/items.py");
    expect(items).toBeDefined();
    expect(items?.id).toBe("routers/items.py");
    expect(items?.dependsOn).toContain("helpers.py");

    // helpers.py only calls stdlib -> no internal dependencies.
    const helpers = byPath.get("helpers.py");
    expect(helpers).toBeDefined();
    expect(helpers?.dependsOn).toEqual([]);

    // No self-dependency.
    for (const f of files) {
      expect(f.dependsOn).not.toContain(f.id);
    }
  });
});

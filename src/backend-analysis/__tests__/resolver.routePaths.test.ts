import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractFile } from "../extractFile.js";
import type { FileExtractionResult } from "../extractFile.js";
import type { ModuleMap } from "../moduleMap.js";
import { getPythonParser, resetPythonParser } from "../parser.js";
import { resolveRoutePaths } from "../resolver/routePaths.js";
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

/** Module map mirroring sample_app for the three relevant files. */
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
}> {
  const collector = new WarningCollector();
  const perFile = new Map<string, FileExtractionResult>();
  const symbolTables = new Map<string, Map<string, Binding>>();
  const files: [string, string][] = [
    ["main.py", "main.py"],
    ["routers/items.py", "routers/items.py"],
    ["routers/users.py", "routers/users.py"],
  ];
  for (const [rel, fileId] of files) {
    const tree = await parseFixture(rel);
    perFile.set(fileId, extractFile(fileId, tree, collector));
    symbolTables.set(fileId, buildSymbolTable(tree, fileId));
  }
  return { perFile, symbolTables };
}

describe("resolveRoutePaths", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("produces full prefix-chained route paths for sample_app (Req 1.2, 1.3)", async () => {
    const { perFile, symbolTables } = await buildSample();
    const map = sampleModuleMap();
    const collector = new WarningCollector();

    const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

    const byId = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));

    const getItem = byId.get("GET /api/items/{item_id}");
    expect(getItem).toBeDefined();
    expect(getItem?.entryFunctionId).toBe("sample_app.routers.items:get_item");
    expect(getItem?.handler.file).toBe("routers/items.py");
    expect(getItem?.schemaRefs).toEqual([]);

    const createItem = byId.get("POST /api/items");
    expect(createItem).toBeDefined();
    expect(createItem?.entryFunctionId).toBe("sample_app.routers.items:create_item");

    const getUser = byId.get("GET /users/{user_id}");
    expect(getUser).toBeDefined();
    expect(getUser?.entryFunctionId).toBe("sample_app.routers.users:get_user");

    const createUser = byId.get("POST /users");
    expect(createUser).toBeDefined();
    expect(createUser?.entryFunctionId).toBe("sample_app.routers.users:create_user");

    // exactly the four resolvable routes (dynamic route excluded upstream).
    expect(routes).toHaveLength(4);
    expect(routes.some((r) => r.entryFunctionId.endsWith(":get_dynamic_item"))).toBe(false);
  });

  it("returns [] and warns when there is no FastAPI instance (Req 5.2, 5.3)", async () => {
    const { perFile, symbolTables } = await buildSample();
    // Remove the app instance from main.py.
    const main = perFile.get("main.py");
    if (main !== undefined) {
      perFile.set("main.py", { ...main, fastapiInstances: [] });
    }
    const map = sampleModuleMap();
    const collector = new WarningCollector();

    const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

    expect(routes).toEqual([]);
    expect(collector.warnings.length).toBeGreaterThan(0);
    expect(collector.warnings.some((w) => w.target === "FastAPI()")).toBe(true);
  });

  it("returns [] and warns when there are multiple FastAPI instances (Req 5.2, 5.3)", async () => {
    const { perFile, symbolTables } = await buildSample();
    const main = perFile.get("main.py");
    if (main !== undefined) {
      perFile.set("main.py", {
        ...main,
        fastapiInstances: [
          ...main.fastapiInstances,
          { variableName: "app2", location: { file: "main.py", line: 99 } },
        ],
      });
    }
    const map = sampleModuleMap();
    const collector = new WarningCollector();

    const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

    expect(routes).toEqual([]);
    expect(collector.warnings.some((w) => w.target === "FastAPI()")).toBe(true);
  });
});

describe("resolveRoutePaths — エイリアス import + f-string prefix のルーター解決", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  async function parseSource(source: string): Promise<Tree> {
    const parser = await getPythonParser();
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error("parse returned null");
    }
    return tree;
  }

  it('`from x import router as r_alias` + `include_router(r_alias, prefix=f"{P}/devices")` を解決する', async () => {
    const mainSrc = [
      "from fastapi import FastAPI",
      "from api.device_api import router as device_router",
      'API_PREFIX = "/v1"',
      "app = FastAPI()",
      'app.include_router(device_router, prefix=f"{API_PREFIX}/devices")',
      "",
    ].join("\n");
    const deviceSrc = [
      "from fastapi import APIRouter",
      "router = APIRouter()",
      '@router.get("/{device_id}")',
      "def device_show(device_id):",
      "    return device_id",
      "",
    ].join("\n");

    const collector = new WarningCollector();
    const perFile = new Map<string, FileExtractionResult>();
    const symbolTables = new Map<string, Map<string, Binding>>();
    for (const [fileId, src] of [
      ["main.py", mainSrc],
      ["api/device_api.py", deviceSrc],
    ] as const) {
      const tree = await parseSource(src);
      perFile.set(fileId, extractFile(fileId, tree, collector));
      symbolTables.set(fileId, buildSymbolTable(tree, fileId));
    }

    const moduleToPath = new Map<string, string>([
      ["backend.main", "main.py"],
      ["backend.api.device_api", "api/device_api.py"],
    ]);
    const pathToModule = new Map<string, string>();
    for (const [m, p] of moduleToPath) {
      pathToModule.set(p, m);
    }
    const map: ModuleMap = {
      moduleToPath,
      pathToModule,
      exportedNames: new Map(),
      parsedFiles: new Map(),
    };

    const routes = resolveRoutePaths(perFile, map, collector, symbolTables);

    expect(routes.map((r) => `${r.method} ${r.path}`)).toContain("GET /v1/devices/{device_id}");
    // エイリアス router が解決され、未解決警告は出ない。
    expect(collector.warnings.some((w) => w.reason.includes("router expression"))).toBe(false);
  });
});

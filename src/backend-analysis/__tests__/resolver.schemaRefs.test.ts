import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Tree } from "web-tree-sitter";
import { beforeEach, describe, expect, it } from "vitest";

import { extractFile } from "../extractFile.js";
import type { FileExtractionResult } from "../extractFile.js";
import type { ModuleMap } from "../moduleMap.js";
import { getPythonParser, resetPythonParser } from "../parser.js";
import { resolveSchemaRefs } from "../resolver/schemaRefs.js";
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

async function parseSource(source: string): Promise<Tree> {
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

async function buildSamplePerFile(
  collector: WarningCollector,
): Promise<Map<string, FileExtractionResult>> {
  const perFile = new Map<string, FileExtractionResult>();
  const files: [string, string][] = [
    ["main.py", "main.py"],
    ["helpers.py", "helpers.py"],
    ["schemas.py", "schemas.py"],
    ["routers/items.py", "routers/items.py"],
    ["routers/users.py", "routers/users.py"],
  ];
  for (const [rel, fileId] of files) {
    const tree = await parseFixture(rel);
    perFile.set(fileId, extractFile(fileId, tree, collector));
  }
  return perFile;
}

describe("resolveSchemaRefs", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("resolves a cross-file response model to its definition location and role (Req 2.1)", async () => {
    const collector = new WarningCollector();
    const perFile = await buildSamplePerFile(collector);
    const map = sampleModuleMap();

    const result = resolveSchemaRefs(perFile, map, collector);

    const refs = result.get("sample_app.routers.users:get_user");
    expect(refs).toEqual([
      {
        className: "UserResponse",
        location: { file: "schemas.py", line: 18 },
        role: "response",
      },
    ]);
  });

  it("resolves both request and response cross-file models (Req 2.1)", async () => {
    const collector = new WarningCollector();
    const perFile = await buildSamplePerFile(collector);
    const map = sampleModuleMap();

    const result = resolveSchemaRefs(perFile, map, collector);

    const refs = result.get("sample_app.routers.users:create_user") ?? [];
    expect(refs).toContainEqual({
      className: "UserRequest",
      location: { file: "schemas.py", line: 11 },
      role: "request",
    });
    expect(refs).toContainEqual({
      className: "UserResponse",
      location: { file: "schemas.py", line: 18 },
      role: "response",
    });
    expect(refs).toHaveLength(2);
  });

  it("resolves a locally-defined response model (Req 2.1)", async () => {
    const collector = new WarningCollector();
    const perFile = await buildSamplePerFile(collector);
    const map = sampleModuleMap();

    const result = resolveSchemaRefs(perFile, map, collector);

    const refs = result.get("sample_app.routers.items:get_item");
    expect(refs).toEqual([
      {
        className: "ItemResponse",
        location: { file: "routers/items.py", line: 32 },
        role: "response",
      },
    ]);
  });

  it("resolves local request + response models for create_item (Req 2.1)", async () => {
    const collector = new WarningCollector();
    const perFile = await buildSamplePerFile(collector);
    const map = sampleModuleMap();

    const result = resolveSchemaRefs(perFile, map, collector);

    const refs = result.get("sample_app.routers.items:create_item") ?? [];
    expect(refs).toContainEqual({
      className: "ItemCreate",
      location: { file: "routers/items.py", line: 25 },
      role: "request",
    });
    expect(refs).toContainEqual({
      className: "ItemResponse",
      location: { file: "routers/items.py", line: 32 },
      role: "response",
    });
    expect(refs).toHaveLength(2);
  });

  it("produces no entry for a handler without any model annotation (Req 2.2)", async () => {
    const collector = new WarningCollector();
    const perFile = await buildSamplePerFile(collector);
    const map = sampleModuleMap();

    const result = resolveSchemaRefs(perFile, map, collector);

    // get_dynamic_item returns `dict` and has only `item_id: int` -> no candidates.
    expect(result.has("sample_app.routers.items:get_dynamic_item")).toBe(false);
  });

  it("does not record warnings for the fully-resolvable sample fixtures (Req 5.3)", async () => {
    // Pass1 extraction legitimately records an unrelated route-path warning for
    // `get_dynamic_item` (Requirement 5.2), so isolate the resolver in its own
    // collector to assert specifically that resolveSchemaRefs records nothing.
    const perFile = await buildSamplePerFile(new WarningCollector());
    const map = sampleModuleMap();

    const resolveCollector = new WarningCollector();
    resolveSchemaRefs(perFile, map, resolveCollector);

    expect(resolveCollector.warnings).toEqual([]);
  });

  it("transitively resolves a model that inherits BaseModel through an intermediate base", async () => {
    const collector = new WarningCollector();
    const moduleToPath = new Map<string, string>([
      ["pkg", "__init__.py"],
      ["pkg.models", "models.py"],
      ["pkg.api", "api.py"],
    ]);
    const pathToModule = new Map<string, string>();
    for (const [m, p] of moduleToPath) {
      pathToModule.set(p, m);
    }
    const map: ModuleMap = { moduleToPath, pathToModule, exportedNames: new Map(), parsedFiles: new Map() };

    const modelsSrc = [
      "from pydantic import BaseModel",
      "",
      "",
      "class Base(BaseModel):",
      "    pass",
      "",
      "",
      "class Derived(Base):",
      "    x: int",
      "",
    ].join("\n");
    const apiSrc = [
      "from fastapi import APIRouter",
      "",
      "from .models import Derived",
      "",
      "router = APIRouter()",
      "",
      "",
      "@router.post('/x')",
      "def handler(body: Derived) -> Derived:",
      "    return body",
      "",
    ].join("\n");

    const perFile = new Map<string, FileExtractionResult>();
    perFile.set("models.py", extractFile("models.py", await parseSource(modelsSrc), collector));
    perFile.set("api.py", extractFile("api.py", await parseSource(apiSrc), collector));

    const result = resolveSchemaRefs(perFile, map, collector);
    const refs = result.get("pkg.api:handler") ?? [];

    expect(refs).toContainEqual({
      className: "Derived",
      location: { file: "models.py", line: 8 },
      role: "request",
    });
    expect(refs).toContainEqual({
      className: "Derived",
      location: { file: "models.py", line: 8 },
      role: "response",
    });
    expect(collector.warnings).toEqual([]);
  });

  it("records a warning and adds no ref for a non-BaseModel imported class (Req 5.3)", async () => {
    const collector = new WarningCollector();
    const moduleToPath = new Map<string, string>([
      ["pkg", "__init__.py"],
      ["pkg.models", "models.py"],
      ["pkg.api", "api.py"],
    ]);
    const pathToModule = new Map<string, string>();
    for (const [m, p] of moduleToPath) {
      pathToModule.set(p, m);
    }
    const map: ModuleMap = { moduleToPath, pathToModule, exportedNames: new Map(), parsedFiles: new Map() };

    const modelsSrc = ["class Plain:", "    x: int", ""].join("\n");
    const apiSrc = [
      "from fastapi import APIRouter",
      "",
      "from .models import Plain",
      "",
      "router = APIRouter()",
      "",
      "",
      "@router.post('/x')",
      "def handler(body: Plain) -> None:",
      "    return None",
      "",
    ].join("\n");

    const perFile = new Map<string, FileExtractionResult>();
    perFile.set("models.py", extractFile("models.py", await parseSource(modelsSrc), collector));
    perFile.set("api.py", extractFile("api.py", await parseSource(apiSrc), collector));

    const result = resolveSchemaRefs(perFile, map, collector);

    // No SchemaReference produced for the non-BaseModel class.
    expect(result.get("pkg.api:handler") ?? []).toEqual([]);
    // A warning targeting the handler was recorded.
    expect(collector.warnings.length).toBeGreaterThanOrEqual(1);
    expect(collector.warnings.some((w) => w.target === "pkg.api:handler")).toBe(true);
  });

  it("records a warning for an unresolvable imported class target (Req 5.3)", async () => {
    const collector = new WarningCollector();
    const moduleToPath = new Map<string, string>([
      ["pkg", "__init__.py"],
      ["pkg.api", "api.py"],
    ]);
    const pathToModule = new Map<string, string>();
    for (const [m, p] of moduleToPath) {
      pathToModule.set(p, m);
    }
    const map: ModuleMap = { moduleToPath, pathToModule, exportedNames: new Map(), parsedFiles: new Map() };

    // Imports `Ghost` from a module that is not in the perFile/registry.
    const apiSrc = [
      "from fastapi import APIRouter",
      "",
      "from .missing import Ghost",
      "",
      "router = APIRouter()",
      "",
      "",
      "@router.post('/x')",
      "def handler(body: Ghost) -> None:",
      "    return None",
      "",
    ].join("\n");

    const perFile = new Map<string, FileExtractionResult>();
    perFile.set("api.py", extractFile("api.py", await parseSource(apiSrc), collector));

    const result = resolveSchemaRefs(perFile, map, collector);

    expect(result.get("pkg.api:handler") ?? []).toEqual([]);
    expect(collector.warnings.some((w) => w.target === "pkg.api:handler")).toBe(true);
  });
});

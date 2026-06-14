import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { buildModuleMap, isInternalModule } from "../moduleMap.js";
import { resetPythonParser } from "../parser.js";
import { WarningCollector } from "../warnings.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

describe("buildModuleMap", () => {
  beforeEach(() => {
    resetPythonParser();
  });

  it("builds module<->path correspondence for every parseable file", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    expect(map.moduleToPath.get("sample_app")).toBe("__init__.py");
    expect(map.moduleToPath.get("sample_app.main")).toBe("main.py");
    expect(map.moduleToPath.get("sample_app.schemas")).toBe("schemas.py");
    expect(map.moduleToPath.get("sample_app.helpers")).toBe("helpers.py");
    expect(map.moduleToPath.get("sample_app.routers")).toBe("routers/__init__.py");
    expect(map.moduleToPath.get("sample_app.routers.items")).toBe("routers/items.py");
    expect(map.moduleToPath.get("sample_app.routers.users")).toBe("routers/users.py");
  });

  it("exposes pathToModule as the inverse of moduleToPath", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    expect(map.pathToModule.get("__init__.py")).toBe("sample_app");
    expect(map.pathToModule.get("main.py")).toBe("sample_app.main");
    expect(map.pathToModule.get("routers/items.py")).toBe("sample_app.routers.items");
    expect(map.pathToModule.get("routers/__init__.py")).toBe("sample_app.routers");

    for (const [moduleName, fileId] of map.moduleToPath) {
      expect(map.pathToModule.get(fileId)).toBe(moduleName);
    }
  });

  it("skips a file with a syntax error and records exactly one warning (Req 5.1)", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    expect(map.moduleToPath.has("sample_app.routers.broken")).toBe(false);
    expect(map.pathToModule.has("routers/broken.py")).toBe(false);

    expect(collector.warnings).toHaveLength(1);
    expect(collector.warnings[0]?.target).toContain("broken.py");
  });

  it("collects exported top-level names (class/def/import bindings)", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    const itemsExports = map.exportedNames.get("sample_app.routers.items");
    expect(itemsExports).toBeDefined();
    // local class names
    expect(itemsExports?.has("ItemCreate")).toBe(true);
    expect(itemsExports?.has("ItemResponse")).toBe(true);
    // local def names
    expect(itemsExports?.has("get_item")).toBe(true);
    expect(itemsExports?.has("create_item")).toBe(true);
    // import-bound name (from fastapi import APIRouter)
    expect(itemsExports?.has("APIRouter")).toBe(true);

    const schemasExports = map.exportedNames.get("sample_app.schemas");
    expect(schemasExports?.has("UserRequest")).toBe(true);
    expect(schemasExports?.has("UserResponse")).toBe(true);
  });

  it("only scans .py files under backendRoot (Req 6.1)", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    for (const fileId of map.pathToModule.keys()) {
      expect(fileId.endsWith(".py")).toBe(true);
    }
  });
});

describe("isInternalModule", () => {
  it("resolves internal modules and their ancestors (Req 3.3)", async () => {
    const collector = new WarningCollector();
    const map = await buildModuleMap(SAMPLE_APP, collector);

    // exact module present
    expect(isInternalModule(map, "sample_app.routers.items")).toBe(true);
    // ancestor packages present
    expect(isInternalModule(map, "sample_app.routers")).toBe(true);
    expect(isInternalModule(map, "sample_app")).toBe(true);
    // a submodule that resolves only via an ancestor package
    expect(isInternalModule(map, "sample_app.routers.items.get_item")).toBe(true);

    // external packages are not internal
    expect(isInternalModule(map, "fastapi")).toBe(false);
    expect(isInternalModule(map, "pydantic")).toBe(false);
  });
});

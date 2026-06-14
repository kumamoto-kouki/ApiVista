import { describe, expect, it } from "vitest";

import type { ModuleMap } from "../moduleMap.js";
import { resolveImportQualifiedName, resolveRelativeModule } from "../resolver/imports.js";

/** Build a small in-memory ModuleMap for split-scenario tests. */
function makeMap(modulePaths: Record<string, string>): ModuleMap {
  const moduleToPath = new Map<string, string>();
  const pathToModule = new Map<string, string>();
  for (const [module, fileId] of Object.entries(modulePaths)) {
    moduleToPath.set(module, fileId);
    pathToModule.set(fileId, module);
  }
  return { moduleToPath, pathToModule, exportedNames: new Map() };
}

describe("resolveRelativeModule", () => {
  it("resolves a double-dot relative name by dropping two trailing segments", () => {
    expect(resolveRelativeModule("..helpers", "sample_app.routers.items")).toBe(
      "sample_app.helpers",
    );
  });

  it("resolves a single-dot relative name by dropping one trailing segment", () => {
    expect(resolveRelativeModule(".routers.items", "sample_app.main")).toBe(
      "sample_app.routers.items",
    );
  });

  it("resolves a deeper double-dot relative name", () => {
    expect(resolveRelativeModule("..helpers.format_item_label", "sample_app.routers.items")).toBe(
      "sample_app.helpers.format_item_label",
    );
  });

  it("leaves an already-absolute (no leading dot) name unchanged", () => {
    expect(resolveRelativeModule("sample_app.helpers", "sample_app.routers.items")).toBe(
      "sample_app.helpers",
    );
  });
});

describe("resolveImportQualifiedName", () => {
  const map = makeMap({
    "sample_app.main": "main.py",
    "sample_app.routers.items": "routers/items.py",
    "sample_app.helpers": "helpers.py",
  });

  it("splits a module-only import (whole resolved name is a module key)", () => {
    // `from .routers import items` -> qualifiedName ".routers.items" in main.py.
    const res = resolveImportQualifiedName(".routers.items", "main.py", map);
    expect(res.moduleDotted).toBe("sample_app.routers.items");
    expect(res.name).toBe("");
    expect(res.targetFileId).toBe("routers/items.py");
  });

  it("splits a name-in-module import (longest module prefix + trailing name)", () => {
    // `from ..helpers import format_item_label` -> "..helpers.format_item_label" in routers/items.py.
    const res = resolveImportQualifiedName("..helpers.format_item_label", "routers/items.py", map);
    expect(res.moduleDotted).toBe("sample_app.helpers");
    expect(res.name).toBe("format_item_label");
    expect(res.targetFileId).toBe("helpers.py");
  });

  it("falls back to last-segment-as-name when no module prefix matches (external)", () => {
    const res = resolveImportQualifiedName("fastapi.APIRouter", "main.py", map);
    expect(res.moduleDotted).toBe("fastapi");
    expect(res.name).toBe("APIRouter");
    expect(res.targetFileId).toBeNull();
  });
});

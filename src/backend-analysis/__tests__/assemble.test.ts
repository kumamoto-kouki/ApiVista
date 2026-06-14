import { describe, expect, it } from "vitest";

import { assembleOutput } from "../assemble.js";
import type {
  FileNode,
  FunctionNode,
  RouteDefinition,
  SchemaReference,
  Warning,
} from "../models.js";
import { SCHEMA_VERSION } from "../models.js";

/** entryFunctionId をハンドラ関数の id に揃えたベース固定値。 */
const HANDLER_ID = "sample_app.routers.items:get_item";
const FILE_ID = "routers/items.py";

function makeRoute(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    method: "GET",
    path: "/api/items/{item_id}",
    handler: { file: FILE_ID, line: 10 },
    entryFunctionId: HANDLER_ID,
    schemaRefs: [],
    ...overrides,
  };
}

describe("assembleOutput", () => {
  it("merges schemaRefs by entryFunctionId", () => {
    const refs: SchemaReference[] = [
      {
        className: "ItemResponse",
        location: { file: FILE_ID, line: 3 },
        role: "response",
      },
    ];
    const route = makeRoute();
    const out = assembleOutput([route], new Map([[HANDLER_ID, refs]]), [], [], []);

    expect(out.routes[0]?.schemaRefs).toEqual(refs);
  });

  it("uses an empty schemaRefs array when the handler is absent from the map (Req 2.2)", () => {
    const route = makeRoute({ entryFunctionId: "sample_app.routers.items:other" });
    const out = assembleOutput(
      [route],
      new Map([
        [
          HANDLER_ID,
          [{ className: "ItemResponse", location: { file: FILE_ID, line: 3 }, role: "response" }],
        ],
      ]),
      [],
      [],
      [],
    );

    expect(out.routes[0]?.schemaRefs).toEqual([]);
  });

  it("pins schemaVersion and passes functions/files/warnings through unchanged", () => {
    const functions: FunctionNode[] = [
      {
        id: HANDLER_ID,
        name: "get_item",
        file: FILE_ID,
        location: { file: FILE_ID, line: 10 },
        calls: [],
      },
    ];
    const files: FileNode[] = [{ id: FILE_ID, path: FILE_ID, dependsOn: [] }];
    const warnings: Warning[] = [{ target: "routers/broken.py", reason: "syntax error" }];

    const out = assembleOutput([makeRoute()], new Map(), functions, files, warnings);

    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.schemaVersion).toBe(1);
    expect(out.functions).toBe(functions);
    expect(out.files).toBe(files);
    expect(out.warnings).toBe(warnings);
  });

  it("preserves entryFunctionId->functions->file->files reference integrity (Req 4.2/4.3)", () => {
    const route = makeRoute();
    const functions: FunctionNode[] = [
      {
        id: HANDLER_ID,
        name: "get_item",
        file: FILE_ID,
        location: { file: FILE_ID, line: 10 },
        calls: [],
      },
    ];
    const files: FileNode[] = [{ id: FILE_ID, path: FILE_ID, dependsOn: [] }];

    const out = assembleOutput([route], new Map(), functions, files, []);

    const fn = out.functions.find((f) => f.id === out.routes[0]?.entryFunctionId);
    expect(fn).toBeDefined();
    const file = out.files.find((f) => f.id === fn?.file);
    expect(file).toBeDefined();
    expect(file?.path).toBe(FILE_ID);
  });

  it("preserves input order of routes", () => {
    const a = makeRoute({ entryFunctionId: "m:a", path: "/a" });
    const b = makeRoute({ entryFunctionId: "m:b", path: "/b" });
    const c = makeRoute({ entryFunctionId: "m:c", path: "/c" });

    const out = assembleOutput([a, b, c], new Map(), [], [], []);

    expect(out.routes.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("does not mutate the input routes", () => {
    const route = makeRoute();
    const refs: SchemaReference[] = [
      { className: "ItemResponse", location: { file: FILE_ID, line: 3 }, role: "response" },
    ];

    const out = assembleOutput([route], new Map([[HANDLER_ID, refs]]), [], [], []);

    expect(route.schemaRefs).toEqual([]);
    expect(out.routes[0]).not.toBe(route);
  });
});

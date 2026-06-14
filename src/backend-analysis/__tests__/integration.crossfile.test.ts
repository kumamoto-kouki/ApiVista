/**
 * クロスファイル解決の統合テスト（task 5.1）。
 *
 * `analyzeBackend` のパイプライン全体を実フィクスチャ `tests/fixtures/sample_app`
 * に対して（モックなしで）駆動し、複数ファイルにまたがる関心事をエンドツーエンドで
 * 検証する。各シナリオを要件番号にマッピングする:
 *   - Requirements 1.2, 1.3: 複数ファイルにわたる prefix チェーンの完全パス算出
 *   - Requirement 5.2: 動的（非リテラル）パスのルート除外と警告
 *   - Requirements 3.1, 3.3: クロスファイル呼び出しグラフ + 外部終端の除外
 *   - Requirements 2.1, 2.2: 別ファイル定義モデルのクロスファイルスキーマ解決
 *
 * 既存の per-unit テストおよび index.test.ts とは異なり、本ファイルは「クロスファイル
 * 解決が統合パイプラインで一貫して成立すること」に焦点を当てた具体的アサーションのみ
 * を置く。値は実フィクスチャを読んで確定した。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeBackend } from "../index.js";
import type { AnalysisOutput, FunctionNode, RouteDefinition, SchemaReference } from "../index.js";
import { resetPythonParser } from "../parser.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/backend-analysis/__tests__ -> repo root -> tests/fixtures/sample_app
const SAMPLE_APP = join(here, "..", "..", "..", "tests", "fixtures", "sample_app");

let output: AnalysisOutput;

beforeAll(async () => {
  resetPythonParser();
  output = await analyzeBackend(SAMPLE_APP);
});

function findRoute(method: string, path: string): RouteDefinition | undefined {
  return output.routes.find((r) => r.method === method && r.path === path);
}

function findFunction(id: string): FunctionNode | undefined {
  return output.functions.find((f) => f.id === id);
}

function refsFor(entryFunctionId: string): SchemaReference[] {
  return output.routes.find((r) => r.entryFunctionId === entryFunctionId)?.schemaRefs ?? [];
}

describe("integration: cross-file route resolution against sample_app", () => {
  describe("prefix chain full paths across files (Req 1.2, 1.3)", () => {
    it("combines include_router prefix '/api' with the router's own '/items' prefix", () => {
      // main.py: app.include_router(items.router, prefix="/api")
      // routers/items.py: APIRouter(prefix="/items"), @router.get("/{item_id}")
      const getItem = findRoute("GET", "/api/items/{item_id}");
      expect(getItem).toBeDefined();
      expect(getItem?.entryFunctionId).toBe("sample_app.routers.items:get_item");
      expect(getItem?.handler).toEqual({ file: "routers/items.py", line: 41 });

      // @router.post(""), empty path collapses to the prefix chain only.
      const postItem = findRoute("POST", "/api/items");
      expect(postItem).toBeDefined();
      expect(postItem?.entryFunctionId).toBe("sample_app.routers.items:create_item");
      expect(postItem?.handler).toEqual({ file: "routers/items.py", line: 49 });
    });

    it("uses only the router's own '/users' prefix when included without an extra prefix", () => {
      // main.py: app.include_router(users.router)  (no prefix=)
      // routers/users.py: APIRouter(prefix="/users")
      const getUser = findRoute("GET", "/users/{user_id}");
      expect(getUser).toBeDefined();
      expect(getUser?.entryFunctionId).toBe("sample_app.routers.users:get_user");
      expect(getUser?.handler).toEqual({ file: "routers/users.py", line: 19 });

      const postUser = findRoute("POST", "/users");
      expect(postUser).toBeDefined();
      expect(postUser?.entryFunctionId).toBe("sample_app.routers.users:create_user");
      expect(postUser?.handler).toEqual({ file: "routers/users.py", line: 26 });
    });

    it("does not introduce any spurious '/api'-prefixed users route", () => {
      // The "/api" prefix must apply only to the items router, not bleed across files.
      expect(output.routes.some((r) => r.path.startsWith("/api/users"))).toBe(false);
    });
  });

  describe("dynamic (non-literal) route excluded with a warning (Req 5.2)", () => {
    it("omits get_dynamic_item from routes entirely", () => {
      // routers/items.py: @router.get(DYNAMIC_SEGMENT) -- path is a module-level
      // variable, statically unresolvable, so the route must be dropped.
      expect(output.routes.some((r) => r.entryFunctionId.endsWith(":get_dynamic_item"))).toBe(
        false,
      );
      // And no route may have a path derived from the "/dynamic" segment value.
      expect(output.routes.some((r) => r.path.includes("/dynamic"))).toBe(false);
    });

    it("records a warning targeting routers/items.py:get_dynamic_item", () => {
      const warning = output.warnings.find((w) => w.target === "routers/items.py:get_dynamic_item");
      expect(warning).toBeDefined();
      expect(warning?.reason).toMatch(/string literal/i);
    });
  });

  describe("cross-file call graph and external terminal calls (Req 3.1, 3.3)", () => {
    it("links get_item to the helper defined in another file", () => {
      // routers/items.py:get_item calls helpers.py:format_item_label.
      const getItem = findFunction("sample_app.routers.items:get_item");
      expect(getItem).toBeDefined();
      expect(getItem?.calls).toContain("sample_app.helpers:format_item_label");
    });

    it("includes the cross-file helper as a node with no internal calls (terminal)", () => {
      // format_item_label only calls json.dumps (stdlib / outside backend), which
      // must NOT appear as an internal edge -> its calls list is empty.
      const helper = findFunction("sample_app.helpers:format_item_label");
      expect(helper).toBeDefined();
      expect(helper?.file).toBe("helpers.py");
      expect(helper?.location).toEqual({ file: "helpers.py", line: 13 });
      expect(helper?.calls).toEqual([]);
    });

    it("excludes all external calls (constructors/builtins/fastapi/stdlib) from every node", () => {
      // No internal edge may point at a non-backend id. Backend ids are exactly
      // the set of FunctionNode ids; every edge must resolve to one of them.
      const internalIds = new Set(output.functions.map((f) => f.id));
      for (const fn of output.functions) {
        for (const callee of fn.calls) {
          expect(internalIds.has(callee)).toBe(true);
        }
      }
      // Concretely, the ItemResponse constructor call inside get_item is external
      // and must not appear as an edge.
      const getItem = findFunction("sample_app.routers.items:get_item");
      expect(getItem?.calls.some((c) => c.endsWith(":ItemResponse"))).toBe(false);
    });

    it("derives a file-level dependency from routers/items.py to helpers.py", () => {
      const itemsFile = output.files.find((f) => f.id === "routers/items.py");
      expect(itemsFile).toBeDefined();
      expect(itemsFile?.dependsOn).toContain("helpers.py");
    });
  });

  describe("cross-file schema reference resolution (Req 2.1, 2.2)", () => {
    it("resolves create_user request/response models to schemas.py (cross-file)", () => {
      // routers/users.py imports UserRequest/UserResponse from ..schemas.
      const refs = refsFor("sample_app.routers.users:create_user");
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
    });

    it("resolves get_user response model to schemas.py (cross-file, response only)", () => {
      const refs = refsFor("sample_app.routers.users:get_user");
      expect(refs).toEqual([
        {
          className: "UserResponse",
          location: { file: "schemas.py", line: 18 },
          role: "response",
        },
      ]);
    });

    it("resolves item models to their local definitions in routers/items.py", () => {
      const getItem = refsFor("sample_app.routers.items:get_item");
      expect(getItem).toEqual([
        {
          className: "ItemResponse",
          location: { file: "routers/items.py", line: 32 },
          role: "response",
        },
      ]);

      const createItem = refsFor("sample_app.routers.items:create_item");
      expect(createItem).toContainEqual({
        className: "ItemCreate",
        location: { file: "routers/items.py", line: 25 },
        role: "request",
      });
      expect(createItem).toContainEqual({
        className: "ItemResponse",
        location: { file: "routers/items.py", line: 32 },
        role: "response",
      });
    });

    it("yields empty schemaRefs for the dynamic handler (it has no resolvable route) (Req 2.2)", () => {
      // get_dynamic_item has no model annotation AND is excluded from routes, so
      // no route carries schema references for it.
      expect(output.routes.some((r) => r.entryFunctionId.endsWith(":get_dynamic_item"))).toBe(
        false,
      );
      // All emitted routes that lack a model annotation in the fixture do still
      // carry their annotated models; assert the invariant that every schemaRef
      // resolved to a concrete BaseModel-derived class location (non-empty file).
      for (const route of output.routes) {
        for (const ref of route.schemaRefs) {
          expect(ref.location.file).not.toBe("");
          expect(ref.location.line).toBeGreaterThan(0);
        }
      }
    });
  });
});

/**
 * クロスファイル解決の統合テスト（task 6.1）。
 *
 * 公開API `analyzeFrontend` のパイプライン全体を実フィクスチャ `tests/fixtures/sample_nuxt`
 * に対して（モックなしで）駆動し、Pass0→Pass1→Pass2→Assemble をエンドツーエンドで通した
 * 最終出力 `AnalysisOutput` を起点に、複数ファイルにまたがる関心事を実値で検証する。
 *
 * 各シナリオを要件番号にマッピングする:
 *   - Req 1.1, 1.2, 1.3: 各API呼び出し形態（`useFetch`/`$fetch`/`axios.get`/`axios.post`）の
 *     method 抽出（呼び出し名・既定GET）と URLパターン正規化（テンプレートリテラル→`{}`）
 *   - Req 1.5: 認識対象外クライアント（`customClient.fetchData`）は非抽出
 *   - Req 4.2, 4.3: 完全動的URL（`axios.get(buildUrl())`）の除外と警告記録
 *   - Req 1.4 / design「コンポーネントノード規約」: `<script setup>` 直下の呼び出しが
 *     コンポーネントノードへ帰属、名前付き関数内はその関数へ帰属
 *   - Req 2.1: template 経由のコンポーネント間エッジ（auto-import 命名: `UserList`/`BaseButton`）
 *   - Req 2.1 / 2.3: auto-import 名前索引解決・`~/`/`@/` エイリアス解決・外部（axios本体）終端
 *   - Req 4.1: 構文エラー / SFCエラーファイルの skip + 警告（ノード化されない）
 *   - Req 3.3: 複数 script ブロック併存時の行マッピング（第2ブロック呼び出し位置）
 *   - Req 3.1, 3.2: 単一データセット出力・schemaVersion=1・参照貫通・ファイルグラフ導出
 *
 * 既存の per-unit テストおよび index.test.ts とは異なり、本ファイルは「統合パイプラインの
 * 最終出力で全観点が一貫して成立すること」に焦点を当て、具体的な id / urlPattern / method /
 * 行番号の実値でアサートする（タウトロジー禁止）。値は実フィクスチャを解析して確定した。
 */
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { analyzeFrontend } from "../index.js";
import { SCHEMA_VERSION } from "../models.js";

import type { AnalysisOutput, ApiCall, FunctionNode } from "../index.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

let output: AnalysisOutput;

beforeAll(() => {
  output = analyzeFrontend(SAMPLE_NUXT);
});

function findFunction(id: string): FunctionNode | undefined {
  return output.functions.find((f) => f.id === id);
}

/** 指定 enclosingFunctionId に帰属する API 呼び出しを返す。 */
function apiCallsIn(enclosingFunctionId: string): ApiCall[] {
  return output.apiCalls.filter((c) => c.enclosingFunctionId === enclosingFunctionId);
}

describe("integration: cross-file frontend resolution against sample_nuxt", () => {
  // 観点1: 各API呼び出し形態の method / URLパターン正規化（Req 1.1, 1.2, 1.3）
  describe("api call method/url normalization across shapes (Req 1.1, 1.2, 1.3)", () => {
    it("useFetch with a literal URL and no method option defaults to GET (pages/users.vue)", () => {
      // pages/users.vue: const { data } = useFetch('/api/users')
      const calls = apiCallsIn("pages/users:Users");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "GET",
        urlPattern: "/api/users",
        location: { file: "pages/users.vue", line: 15 },
      });
    });

    it("axios.get / axios.post extract GET / POST from the call name (composables/useUserApi.ts)", () => {
      // export function fetchUsers() { return axios.get("/api/users"); }
      const getCall = apiCallsIn("composables/useUserApi:fetchUsers");
      expect(getCall).toHaveLength(1);
      expect(getCall[0]).toMatchObject({
        method: "GET",
        urlPattern: "/api/users",
        location: { file: "composables/useUserApi.ts", line: 31 },
      });

      // export function createUser() { return axios.post("/api/users", ...); }
      const postCall = apiCallsIn("composables/useUserApi:createUser");
      expect(postCall).toHaveLength(1);
      expect(postCall[0]).toMatchObject({
        method: "POST",
        urlPattern: "/api/users",
        location: { file: "composables/useUserApi.ts", line: 36 },
      });
    });

    it("template-literal URLs normalize the dynamic segment to a placeholder `{}` (Req 1.3)", () => {
      // composables/useUserApi.ts: axios.get(`/api/users/${userId}`)
      const fetchUser = apiCallsIn("composables/useUserApi:fetchUser");
      expect(fetchUser).toHaveLength(1);
      expect(fetchUser[0]).toMatchObject({
        method: "GET",
        urlPattern: "/api/users/{}",
        location: { file: "composables/useUserApi.ts", line: 41 },
      });

      // pages/userDetail.vue: $fetch(`/api/users/${id}`) inside loadUser()
      const detail = apiCallsIn("pages/userDetail:loadUser");
      expect(detail).toHaveLength(1);
      expect(detail[0]).toMatchObject({
        method: "GET",
        urlPattern: "/api/users/{}",
        location: { file: "pages/userDetail.vue", line: 18 },
      });
    });
  });

  // 観点2: 動的URL除外 + 警告（Req 4.2, 4.3）
  describe("fully dynamic URL excluded with a warning (Req 4.2, 4.3)", () => {
    it("omits axios.get(buildUrl()) from apiCalls entirely", () => {
      // composables/useUserApi.ts: fetchDynamic() -> axios.get(buildUrl())
      // The URL skeleton is itself dynamic (function result), so the call must be
      // dropped. No api call may be attributed to fetchDynamic.
      expect(apiCallsIn("composables/useUserApi:fetchDynamic")).toHaveLength(0);
    });

    it("records a warning for the excluded dynamic URL at its source line", () => {
      const warning = output.warnings.find(
        (w) =>
          w.target === "composables/useUserApi.ts" && /not statically determinable/i.test(w.reason),
      );
      expect(warning).toBeDefined();
      // The fully dynamic call sits on .ts line 46 (axios.get(buildUrl())).
      expect(warning?.reason).toMatch(/line 46/);
    });
  });

  // 観点3: <script setup> 直下呼び出しのコンポーネントノード帰属 / 名前付き関数帰属（Req 1.4）
  describe("top-level <script setup> call attribution (Req 1.4, component-node convention)", () => {
    it("attributes a top-level useFetch to the .vue component node, not a function", () => {
      // pages/users.vue has NO named function around useFetch -> belongs to `Users`.
      const calls = apiCallsIn("pages/users:Users");
      expect(calls).toHaveLength(1);
      // The component node itself exists as a FunctionNode (so the api call points
      // at a real node, completing reference pass-through).
      const node = findFunction("pages/users:Users");
      expect(node).toBeDefined();
      expect(node?.name).toBe("Users");
      expect(node?.file).toBe("pages/users.vue");
    });

    it("attributes a call wrapped in a named function to THAT function, not the component", () => {
      // pages/userDetail.vue: $fetch is inside loadUser(), so it must NOT be on the
      // component node `UserDetail`.
      expect(apiCallsIn("pages/userDetail:loadUser")).toHaveLength(1);
      expect(apiCallsIn("pages/userDetail:UserDetail")).toHaveLength(0);
      // Yet the component node still exists and reaches loadUser via an edge.
      expect(findFunction("pages/userDetail:UserDetail")?.calls).toContain(
        "pages/userDetail:loadUser",
      );
    });
  });

  // 観点4: template 経由のコンポーネント間エッジ（Req 2.1）
  describe("template-driven component-to-component edges (Req 2.1)", () => {
    it("adds Users -> UserList edge from <UserList/> in pages/users.vue template", () => {
      const users = findFunction("pages/users:Users");
      expect(users?.calls).toContain("components/UserList:UserList");
    });

    it("adds UserList -> BaseButton edge resolving nested-dir Nuxt naming (Issue 2)", () => {
      // components/UserList.vue template uses <BaseButton/>, which must resolve to
      // components/base/Button.vue indexed as `BaseButton` (directory-prefix naming).
      const userList = findFunction("components/UserList:UserList");
      expect(userList?.calls).toContain("components/base/Button:BaseButton");
      // The resolution target node exists.
      const baseButton = findFunction("components/base/Button:BaseButton");
      expect(baseButton).toBeDefined();
      expect(baseButton?.file).toBe("components/base/Button.vue");
    });

    it("connects page -> component -> composable -> API as a reachable chain", () => {
      // Users -> UserList (template) -> loadUsers -> fetchUsers (auto-import) which
      // encloses an api call. Walk the chain explicitly.
      expect(findFunction("pages/users:Users")?.calls).toContain("components/UserList:UserList");
      expect(findFunction("components/UserList:UserList")?.calls).toContain(
        "components/UserList:loadUsers",
      );
      expect(findFunction("components/UserList:loadUsers")?.calls).toContain(
        "composables/useUserApi:fetchUsers",
      );
      // fetchUsers encloses the GET /api/users call.
      expect(apiCallsIn("composables/useUserApi:fetchUsers")).toHaveLength(1);
    });
  });

  // 観点5: auto-import 解決 / エイリアス解決（Req 2.1, 2.3）
  describe("auto-import and alias resolution (Req 2.1, 2.3)", () => {
    it("resolves an auto-imported composable via the export name index (loadUsers -> fetchUsers)", () => {
      // components/UserList.vue calls fetchUsers() with NO import statement.
      const loadUsers = findFunction("components/UserList:loadUsers");
      expect(loadUsers?.calls).toEqual(["composables/useUserApi:fetchUsers"]);
    });

    it("resolves ~/ and @/ alias imports to the same fileId (buildReport -> fetchUsers / createUser)", () => {
      // composables/useReport.ts imports fetchUsers from "~/composables/useUserApi"
      // and createUser from "@/composables/useUserApi" (two distinct aliases, one file).
      const buildReport = findFunction("composables/useReport:buildReport");
      expect(buildReport?.calls).toContain("composables/useUserApi:fetchUsers");
      expect(buildReport?.calls).toContain("composables/useUserApi:createUser");
      // The file-level dependency is derived to the alias-resolved target.
      const reportFile = output.files.find((f) => f.id === "composables/useReport.ts");
      expect(reportFile?.dependsOn).toEqual(["composables/useUserApi.ts"]);
    });
  });

  // 観点6: 外部終端 / 認識対象外非抽出（Req 1.5, 2.3）
  describe("external terminal calls and unrecognized clients (Req 1.5, 2.3)", () => {
    it("treats axios as an external terminal (fetchUsers has no internal call edge)", () => {
      // fetchUsers only calls axios.get (outside frontend) -> empty calls list.
      const fetchUsers = findFunction("composables/useUserApi:fetchUsers");
      expect(fetchUsers).toBeDefined();
      expect(fetchUsers?.calls).toEqual([]);
    });

    it("does not extract customClient.fetchData as an API call (Req 1.5)", () => {
      // fetchViaCustom() calls customClient.fetchData("/api/custom"): not a recognized
      // $fetch/useFetch/axios pattern, so it must not appear as an api call, and the
      // custom URL must not surface anywhere.
      expect(apiCallsIn("composables/useUserApi:fetchViaCustom")).toHaveLength(0);
      expect(output.apiCalls.some((c) => c.urlPattern === "/api/custom")).toBe(false);
    });

    it("keeps every internal edge pointing at a real FunctionNode id (no external bleed)", () => {
      const internalIds = new Set(output.functions.map((f) => f.id));
      for (const fn of output.functions) {
        for (const callee of fn.calls) {
          expect(internalIds.has(callee)).toBe(true);
        }
      }
    });
  });

  // 観点7: 構文エラー / SFCエラーの skip + 警告（Req 4.1）
  describe("syntax/SFC error files are skipped with warnings (Req 4.1)", () => {
    it("does not create any node from useBroken.ts and records its skip", () => {
      // composables/useBroken.ts has a TS syntax error -> skipped, no nodes.
      expect(output.functions.some((f) => f.file === "composables/useBroken.ts")).toBe(false);
      expect(output.apiCalls.some((c) => c.location.file === "composables/useBroken.ts")).toBe(
        false,
      );
      const warning = output.warnings.find((w) => w.target === "composables/useBroken.ts");
      expect(warning).toBeDefined();
      expect(warning?.reason).toMatch(/syntax error/i);
    });

    it("does not create any node from BrokenWidget.vue and records its SFC skip", () => {
      // components/BrokenWidget.vue is an invalid SFC -> skipped, no component node.
      expect(output.functions.some((f) => f.file === "components/BrokenWidget.vue")).toBe(false);
      expect(findFunction("components/BrokenWidget:BrokenWidget")).toBeUndefined();
      const warning = output.warnings.find((w) => w.target === "components/BrokenWidget.vue");
      expect(warning).toBeDefined();
      expect(warning?.reason).toMatch(/syntax error|end tag/i);
    });

    it("still analyzes the remaining valid files despite the broken ones", () => {
      // Valid files must still produce nodes (partial execution continued).
      expect(findFunction("pages/users:Users")).toBeDefined();
      expect(findFunction("composables/useUserApi:fetchUsers")).toBeDefined();
    });
  });

  // 観点8: 複数 script ブロック併存時の行マッピング（Req 3.3）
  describe("multi-script-block line mapping (Req 3.3)", () => {
    it("maps the useFetch in the SECOND <script setup> block to its real .vue line", () => {
      // components/LegacyWidget.vue has a classic <script> block (legacyHelper) first,
      // then a <script setup> block whose useFetch('/api/widgets') is on real line 25.
      // A single-startLine offset would misreport this; per-segment mapping is required.
      const calls = apiCallsIn("components/LegacyWidget:LegacyWidget");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "GET",
        urlPattern: "/api/widgets",
        location: { file: "components/LegacyWidget.vue", line: 25 },
      });
    });

    it("keeps the classic-block function and the setup component node distinct", () => {
      // legacyHelper (classic block) and LegacyWidget (component node) are separate
      // nodes; the setup block calls legacyHelper.
      const widget = findFunction("components/LegacyWidget:LegacyWidget");
      const helper = findFunction("components/LegacyWidget:legacyHelper");
      expect(widget).toBeDefined();
      expect(helper).toBeDefined();
      expect(widget?.calls).toContain("components/LegacyWidget:legacyHelper");
    });
  });

  // 観点9: 単一データセット・参照貫通・ファイルグラフ（Req 3.1, 3.2）
  describe("single dataset, reference pass-through and file graph (Req 3.1, 3.2)", () => {
    it("emits a single schemaVersion=1 AnalysisOutput", () => {
      expect(output.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it("every ApiCall.enclosingFunctionId resolves to a FunctionNode whose file is a FileNode", () => {
      const functionsById = new Map(output.functions.map((f) => [f.id, f]));
      const fileIds = new Set(output.files.map((f) => f.id));
      expect(output.apiCalls.length).toBeGreaterThan(0);
      for (const call of output.apiCalls) {
        const node = functionsById.get(call.enclosingFunctionId);
        expect(node).toBeDefined();
        expect(fileIds.has(node!.file)).toBe(true);
      }
    });

    it("derives the file graph: pages/users.vue depends on components/UserList.vue", () => {
      // The Users -> UserList function edge aggregates into a file dependency.
      const usersFile = output.files.find((f) => f.id === "pages/users.vue");
      expect(usersFile?.dependsOn).toContain("components/UserList.vue");

      const userListFile = output.files.find((f) => f.id === "components/UserList.vue");
      expect(userListFile?.dependsOn).toEqual(
        expect.arrayContaining(["components/base/Button.vue", "composables/useUserApi.ts"]),
      );
    });
  });
});

import { resolve } from "node:path";

import { Project, SyntaxKind, type SourceFile } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { extractDefs, findEnclosingDef, type FunctionDef } from "../extractors/defs.js";
import { buildProject, type FrontendProject } from "../project.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** 単発の in-memory ts-morph SourceFile を作るヘルパ（.ts/.js 経路 = segments 恒等）。 */
const scratch = new Project({ useInMemoryFileSystem: true });
function makeSource(fileId: string, code: string): SourceFile {
  return scratch.createSourceFile(`scratch/${fileId}`, code, { overwrite: true });
}

/** qualname で定義を引く（順不同の比較用）。 */
function byQualname(defs: FunctionDef[], qualname: string): FunctionDef | undefined {
  return defs.find((d) => d.qualname === qualname);
}

describe("extractDefs — top-level function / arrow / composable defs (Req 2.1)", () => {
  it("collects top-level function declarations as definitions", () => {
    const sf = makeSource(
      "composables/useUserApi.ts",
      ["export function fetchUsers() { return 1; }", "function helper() { return 2; }"].join("\n"),
    );

    const defs = extractDefs(sf, "composables/useUserApi.ts", []);

    const fetchUsers = byQualname(defs, "fetchUsers");
    const helper = byQualname(defs, "helper");
    expect(fetchUsers).toBeDefined();
    expect(helper).toBeDefined();
    expect(fetchUsers?.id).toBe("composables/useUserApi:fetchUsers");
    expect(fetchUsers?.file).toBe("composables/useUserApi.ts");
    expect(fetchUsers?.name).toBe("fetchUsers");
    expect(fetchUsers?.isComponentNode).toBe(false);
  });

  it("collects named arrow-function and function-expression bindings", () => {
    const sf = makeSource(
      "lib/util.ts",
      [
        "const bar = () => 1;",
        "const baz = function () { return 2; };",
        "const useUsers = () => ({ list: [] });",
      ].join("\n"),
    );

    const defs = extractDefs(sf, "lib/util.ts", []);

    expect(byQualname(defs, "bar")).toBeDefined();
    expect(byQualname(defs, "baz")).toBeDefined();
    expect(byQualname(defs, "useUsers")).toBeDefined();
    expect(byQualname(defs, "useUsers")?.id).toBe("lib/util:useUsers");
  });

  it("does not collect non-callable variable bindings", () => {
    const sf = makeSource("lib/const.ts", ["const COUNT = 3;", "const name = 'x';"].join("\n"));

    const defs = extractDefs(sf, "lib/const.ts", []);

    expect(byQualname(defs, "COUNT")).toBeUndefined();
    expect(byQualname(defs, "name")).toBeUndefined();
  });
});

describe("extractDefs — .vue single component node convention (Req 1.4, 2.1, Issue 2)", () => {
  it("registers a single component node named by the file/dir-derived PascalCase name", () => {
    const sf = makeSource(
      "pages/users.vue.ts",
      ["const { data: users } = useFetch('/api/users')"].join("\n"),
    );

    const defs = extractDefs(sf, "pages/users.vue", []);

    const componentNodes = defs.filter((d) => d.isComponentNode);
    expect(componentNodes).toHaveLength(1);
    const node = componentNodes[0]!;
    expect(node.qualname).toBe("Users");
    expect(node.name).toBe("Users");
    expect(node.id).toBe("pages/users:Users");
    expect(node.file).toBe("pages/users.vue");
  });

  it("derives Nuxt directory-prefixed PascalCase names for nested components", () => {
    const sf = makeSource("components/base/Button.vue.ts", "defineProps()");
    const defs = extractDefs(sf, "components/base/Button.vue", []);
    expect(byQualname(defs, "BaseButton")?.isComponentNode).toBe(true);
  });

  it("also collects named functions inside a .vue alongside the component node", () => {
    const sf = makeSource(
      "pages/userDetail.vue.ts",
      [
        "async function loadUser() {",
        "  const user = await $fetch(`/api/users/${id}`)",
        "  return user",
        "}",
        "loadUser()",
      ].join("\n"),
    );

    const defs = extractDefs(sf, "pages/userDetail.vue", []);

    expect(byQualname(defs, "UserDetail")?.isComponentNode).toBe(true);
    expect(byQualname(defs, "loadUser")?.isComponentNode).toBe(false);
  });
});

describe("findEnclosingDef — nearest-enclosing attribution (Req 1.4)", () => {
  it("attributes a top-level <script setup> call (not in a named fn) to the component node", () => {
    const sf = makeSource(
      "pages/users.vue.ts",
      ["const { data: users } = useFetch('/api/users')"].join("\n"),
    );
    const defs = extractDefs(sf, "pages/users.vue", []);
    const call = sf.getFirstDescendantByKindOrThrow(SyntaxKind.CallExpression);

    const enclosing = findEnclosingDef(call, defs);

    expect(enclosing).toBeDefined();
    expect(enclosing?.isComponentNode).toBe(true);
    expect(enclosing?.id).toBe("pages/users:Users");
  });

  it("attributes a call inside a named function to that function, not the component node", () => {
    const sf = makeSource(
      "pages/userDetail.vue.ts",
      [
        "async function loadUser() {",
        "  const user = await $fetch('/api/users/1')",
        "  return user",
        "}",
      ].join("\n"),
    );
    const defs = extractDefs(sf, "pages/userDetail.vue", []);
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === "$fetch")!;

    const enclosing = findEnclosingDef(call, defs);

    expect(enclosing?.id).toBe("pages/userDetail:loadUser");
    expect(enclosing?.isComponentNode).toBe(false);
  });

  it("returns the top-level function for a call inside a top-level .ts function (no component node)", () => {
    const sf = makeSource(
      "composables/useUserApi.ts",
      ["export function fetchUsers() { return axios.get('/api/users'); }"].join("\n"),
    );
    const defs = extractDefs(sf, "composables/useUserApi.ts", []);
    const call = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === "axios.get")!;

    const enclosing = findEnclosingDef(call, defs);

    expect(enclosing?.id).toBe("composables/useUserApi:fetchUsers");
  });

  it("returns undefined for a top-level call in a .ts file (no enclosing named fn, not a .vue)", () => {
    const sf = makeSource("plain.ts", ["doSomething()"].join("\n"));
    const defs = extractDefs(sf, "plain.ts", []);
    const call = sf.getFirstDescendantByKindOrThrow(SyntaxKind.CallExpression);

    expect(findEnclosingDef(call, defs)).toBeUndefined();
  });
});

describe("extractDefs — real sample_nuxt fixture (observable completion state)", () => {
  let project: FrontendProject;

  beforeAll(() => {
    project = buildProject(SAMPLE_NUXT, {
      record: () => {},
      recordParseError: () => {},
    });
  });

  function defsFor(fileId: string): FunctionDef[] {
    const sf = project.getSourceFile(fileId);
    if (sf === undefined) {
      throw new Error(`source file not in project: ${fileId}`);
    }
    return extractDefs(sf, fileId, project.getSegments(fileId));
  }

  it("collects composable functions from composables/useUserApi.ts", () => {
    const defs = defsFor("composables/useUserApi.ts");
    expect(byQualname(defs, "fetchUsers")?.id).toBe("composables/useUserApi:fetchUsers");
    expect(byQualname(defs, "createUser")?.id).toBe("composables/useUserApi:createUser");
  });

  it("registers one component node per .vue with the conventional name", () => {
    expect(byQualname(defsFor("pages/users.vue"), "Users")?.isComponentNode).toBe(true);
    expect(byQualname(defsFor("pages/userDetail.vue"), "UserDetail")?.isComponentNode).toBe(true);
    expect(byQualname(defsFor("components/UserList.vue"), "UserList")?.isComponentNode).toBe(true);
    expect(byQualname(defsFor("components/base/Button.vue"), "BaseButton")?.isComponentNode).toBe(
      true,
    );
    expect(
      byQualname(defsFor("components/LegacyWidget.vue"), "LegacyWidget")?.isComponentNode,
    ).toBe(true);
  });

  it("attributes the <script setup> top-level useFetch in users.vue to the component node Users", () => {
    const fileId = "pages/users.vue";
    const sf = project.getSourceFile(fileId)!;
    const defs = extractDefs(sf, fileId, project.getSegments(fileId));
    const useFetch = sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => c.getExpression().getText() === "useFetch")!;

    const enclosing = findEnclosingDef(useFetch, defs);

    expect(enclosing?.isComponentNode).toBe(true);
    expect(enclosing?.id).toBe("pages/users:Users");
  });
});

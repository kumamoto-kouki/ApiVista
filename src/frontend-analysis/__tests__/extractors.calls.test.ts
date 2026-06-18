import { resolve } from "node:path";

import { Project, type SourceFile } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";

import { extractCalls, type CallSiteEntry } from "../extractors/calls.js";
import { buildProject, type FrontendProject } from "../project.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** 単発の in-memory ts-morph SourceFile を作るヘルパ（.ts/.js 経路 = segments 恒等）。 */
const scratch = new Project({ useInMemoryFileSystem: true });
function makeSource(fileId: string, code: string): SourceFile {
  return scratch.createSourceFile(`scratch/${fileId}`, code, { overwrite: true });
}

/** caller+callee 組で呼び出しサイトを引く（順不同比較用）。 */
function find(
  calls: CallSiteEntry[],
  callerQualname: string,
  calleeText: string,
): CallSiteEntry | undefined {
  return calls.find((c) => c.callerQualname === callerQualname && c.calleeText === calleeText);
}

describe("extractCalls — call expressions inside named function defs (Req 2.1)", () => {
  it("collects a call inside a top-level function attributed to that function", () => {
    const sf = makeSource(
      "composables/useUserApi.ts",
      ["export function fetchUsers() { return axios.get('/api/users'); }"].join("\n"),
    );

    const calls = extractCalls(sf, "composables/useUserApi.ts", []);

    const entry = find(calls, "fetchUsers", "axios.get");
    expect(entry).toBeDefined();
    expect(entry?.callerQualname).toBe("fetchUsers");
    expect(entry?.calleeText).toBe("axios.get");
    expect(entry?.location.file).toBe("composables/useUserApi.ts");
    expect(entry?.location.line).toBe(1);
  });

  it("collects an identifier call inside a named arrow function", () => {
    const sf = makeSource(
      "composables/useReport.ts",
      [
        "export const buildReport = async () => {",
        "  const u = await fetchUsers()",
        "  await createUser('x')",
        "  return u",
        "}",
      ].join("\n"),
    );

    const calls = extractCalls(sf, "composables/useReport.ts", []);

    expect(find(calls, "buildReport", "fetchUsers")).toBeDefined();
    expect(find(calls, "buildReport", "createUser")).toBeDefined();
  });

  it("does NOT collect a top-level .ts call with no enclosing named function (no component node)", () => {
    const sf = makeSource("plain.ts", ["doSomething()"].join("\n"));

    const calls = extractCalls(sf, "plain.ts", []);

    expect(find(calls, "doSomething", "doSomething")).toBeUndefined();
    // No definition encloses the call -> nothing attributable.
    expect(calls).toHaveLength(0);
  });
});

describe("extractCalls — .vue component-node attribution (Req 1.4, 2.1, Issue 2)", () => {
  it("attributes a top-level <script setup> call to the component node", () => {
    const sf = makeSource(
      "pages/users.vue.ts",
      ["const { data: users } = useFetch('/api/users')"].join("\n"),
    );

    const calls = extractCalls(sf, "pages/users.vue", []);

    const entry = find(calls, "Users", "useFetch");
    expect(entry).toBeDefined();
    expect(entry?.callerQualname).toBe("Users");
  });

  it("attributes a call inside a named fn of a .vue to that fn, not the component node", () => {
    const sf = makeSource(
      "components/UserList.vue.ts",
      [
        "async function loadUsers() {",
        "  const list = await fetchUsers()",
        "  return list",
        "}",
        "loadUsers()",
      ].join("\n"),
    );

    const calls = extractCalls(sf, "components/UserList.vue", []);

    // fetchUsers() is inside loadUsers -> attributed to loadUsers.
    expect(find(calls, "loadUsers", "fetchUsers")).toBeDefined();
    // loadUsers() at top level -> attributed to the component node UserList.
    expect(find(calls, "UserList", "loadUsers")).toBeDefined();
  });
});

describe("extractCalls — real sample_nuxt fixture (observable completion state)", () => {
  let project: FrontendProject;

  beforeAll(() => {
    project = buildProject(SAMPLE_NUXT, {
      record: () => {},
      recordParseError: () => {},
    });
  });

  function callsFor(fileId: string): CallSiteEntry[] {
    const sf = project.getSourceFile(fileId);
    if (sf === undefined) {
      throw new Error(`source file not in project: ${fileId}`);
    }
    return extractCalls(sf, fileId, project.getSegments(fileId));
  }

  it("collects composable-body calls in useUserApi.ts with caller attribution", () => {
    const calls = callsFor("composables/useUserApi.ts");
    expect(find(calls, "fetchUsers", "axios.get")).toBeDefined();
    expect(find(calls, "createUser", "axios.post")).toBeDefined();
    expect(find(calls, "fetchUser", "axios.get")).toBeDefined();
  });

  it("collects auto-import composable call in UserList.vue attributed to loadUsers", () => {
    const calls = callsFor("components/UserList.vue");
    expect(find(calls, "loadUsers", "fetchUsers")).toBeDefined();
    // top-level loadUsers() belongs to the component node.
    expect(find(calls, "UserList", "loadUsers")).toBeDefined();
  });

  it("attributes the top-level useFetch in users.vue to the component node Users", () => {
    const calls = callsFor("pages/users.vue");
    expect(find(calls, "Users", "useFetch")).toBeDefined();
  });

  it("attributes the $fetch in userDetail.vue to the named function loadUser", () => {
    const calls = callsFor("pages/userDetail.vue");
    expect(find(calls, "loadUser", "$fetch")).toBeDefined();
    // loadUser() at top level -> component node UserDetail.
    expect(find(calls, "UserDetail", "loadUser")).toBeDefined();
  });

  it("collects explicit-import composable calls in useReport.ts", () => {
    const calls = callsFor("composables/useReport.ts");
    expect(find(calls, "buildReport", "fetchUsers")).toBeDefined();
    expect(find(calls, "buildReport", "createUser")).toBeDefined();
  });

  it("maps the second-block useFetch line correctly via segments in LegacyWidget.vue", () => {
    const calls = callsFor("components/LegacyWidget.vue");
    // useFetch is in the <script setup> block (line 25 in the .vue source).
    const entry = find(calls, "LegacyWidget", "useFetch");
    expect(entry).toBeDefined();
    expect(entry?.location.line).toBe(25);
  });
});

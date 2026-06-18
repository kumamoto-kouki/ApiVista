import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildFileMap, type FileMap } from "../fileMap.js";
import type { ApiCall, FileNode, FunctionNode } from "../models.js";
import { buildProject, type FrontendProject } from "../project.js";
import {
  annotateApiCalls,
  buildCallGraph,
  deriveFileGraph,
  extractPerFile,
  type FileExtractionResult,
} from "../resolver/callGraph.js";
import { WarningCollector } from "../warnings.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** FunctionNode を id で引く。 */
function node(functions: FunctionNode[], id: string): FunctionNode | undefined {
  return functions.find((f) => f.id === id);
}

/** FileNode を id で引く。 */
function file(files: FileNode[], id: string): FileNode | undefined {
  return files.find((f) => f.id === id);
}

describe("buildCallGraph — sample_nuxt directed call graph (Req 2.1, 2.3)", () => {
  let project: FrontendProject;
  let fileMap: FileMap;
  let perFile: Map<string, FileExtractionResult>;
  let functions: FunctionNode[];
  let apiCalls: ApiCall[];

  beforeAll(() => {
    const collector = new WarningCollector();
    project = buildProject(SAMPLE_NUXT, collector);
    fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    perFile = extractPerFile(project, fileMap, collector);
    functions = buildCallGraph(perFile, fileMap, project);
    apiCalls = annotateApiCalls(perFile);
  });

  it("creates a FunctionNode for the page component node Users", () => {
    const users = node(functions, "pages/users:Users");
    expect(users).toBeDefined();
    expect(users?.file).toBe("pages/users.vue");
  });

  it("connects page -> child component via template edge (Users -> UserList)", () => {
    const users = node(functions, "pages/users:Users");
    expect(users?.calls).toContain("components/UserList:UserList");
  });

  it("resolves nested-directory child component (UserList -> BaseButton)", () => {
    const userList = node(functions, "components/UserList:UserList");
    expect(userList?.calls).toContain("components/base/Button:BaseButton");
  });

  it("resolves an auto-import composable via exportIndex (loadUsers -> fetchUsers)", () => {
    const loadUsers = node(functions, "components/UserList:loadUsers");
    expect(loadUsers?.calls).toContain("composables/useUserApi:fetchUsers");
  });

  it("connects component node UserList -> its named fn loadUsers (intra-file edge)", () => {
    const userList = node(functions, "components/UserList:UserList");
    expect(userList?.calls).toContain("components/UserList:loadUsers");
  });

  it("resolves explicit ~/ and @/ alias imports (buildReport -> fetchUsers/createUser)", () => {
    const buildReport = node(functions, "composables/useReport:buildReport");
    expect(buildReport?.calls).toContain("composables/useUserApi:fetchUsers");
    expect(buildReport?.calls).toContain("composables/useUserApi:createUser");
  });

  it("terminates external library calls (axios.get/.post are not edges)", () => {
    const fetchUsers = node(functions, "composables/useUserApi:fetchUsers");
    expect(fetchUsers).toBeDefined();
    // axios.get is external -> no edge added.
    expect(fetchUsers?.calls).toEqual([]);
  });

  it("does not add an edge for an unrecognized/unresolved callee (customClient.fetchData)", () => {
    const fetchViaCustom = node(functions, "composables/useUserApi:fetchViaCustom");
    expect(fetchViaCustom?.calls ?? []).not.toContain("composables/useUserApi:fetchData");
    expect(fetchViaCustom?.calls).toEqual([]);
  });

  it("page -> component -> composable -> API is connected through calls", () => {
    // Users -> UserList
    expect(node(functions, "pages/users:Users")?.calls).toContain("components/UserList:UserList");
    // UserList -> loadUsers -> fetchUsers (composable)
    expect(node(functions, "components/UserList:UserList")?.calls).toContain(
      "components/UserList:loadUsers",
    );
    expect(node(functions, "components/UserList:loadUsers")?.calls).toContain(
      "composables/useUserApi:fetchUsers",
    );
    // fetchUsers contains the API call (annotated below).
    expect(
      apiCalls.some(
        (c) =>
          c.enclosingFunctionId === "composables/useUserApi:fetchUsers" &&
          c.urlPattern === "/api/users" &&
          c.method === "GET",
      ),
    ).toBe(true);
  });
});

describe("annotateApiCalls — API annotation onto enclosing nodes (Req 1.4)", () => {
  let perFile: Map<string, FileExtractionResult>;
  let apiCalls: ApiCall[];

  beforeAll(() => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    perFile = extractPerFile(project, fileMap, collector);
    apiCalls = annotateApiCalls(perFile);
  });

  it("attributes the top-level useFetch in users.vue to component node Users", () => {
    const call = apiCalls.find((c) => c.location.file === "pages/users.vue");
    expect(call).toBeDefined();
    expect(call?.enclosingFunctionId).toBe("pages/users:Users");
    expect(call?.method).toBe("GET");
    expect(call?.urlPattern).toBe("/api/users");
  });

  it("attributes the $fetch in userDetail.vue to the named function loadUser", () => {
    const call = apiCalls.find((c) => c.location.file === "pages/userDetail.vue");
    expect(call).toBeDefined();
    expect(call?.enclosingFunctionId).toBe("pages/userDetail:loadUser");
    expect(call?.urlPattern).toBe("/api/users/{}");
  });

  it("attributes axios.get/.post in useUserApi.ts to their composables", () => {
    const get = apiCalls.find(
      (c) => c.enclosingFunctionId === "composables/useUserApi:fetchUsers" && c.method === "GET",
    );
    const post = apiCalls.find(
      (c) => c.enclosingFunctionId === "composables/useUserApi:createUser" && c.method === "POST",
    );
    expect(get?.urlPattern).toBe("/api/users");
    expect(post?.urlPattern).toBe("/api/users");
  });

  it("never leaves an empty enclosingFunctionId placeholder", () => {
    expect(apiCalls.every((c) => c.enclosingFunctionId.length > 0)).toBe(true);
  });

  it("every annotated enclosingFunctionId matches an existing FunctionNode (reference integrity)", () => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    const pf = extractPerFile(project, fileMap, collector);
    const functions = buildCallGraph(pf, fileMap, project);
    const ids = new Set(functions.map((f) => f.id));
    const calls = annotateApiCalls(pf);
    for (const c of calls) {
      expect(ids.has(c.enclosingFunctionId)).toBe(true);
    }
  });
});

describe("deriveFileGraph — file-level dependency graph (Req 2.2)", () => {
  let files: FileNode[];

  beforeAll(() => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    const perFile = extractPerFile(project, fileMap, collector);
    const functions = buildCallGraph(perFile, fileMap, project);
    files = deriveFileGraph(functions);
  });

  it("derives pages/users.vue -> components/UserList.vue", () => {
    expect(file(files, "pages/users.vue")?.dependsOn).toContain("components/UserList.vue");
  });

  it("derives components/UserList.vue -> composables/useUserApi.ts (and base/Button.vue)", () => {
    const deps = file(files, "components/UserList.vue")?.dependsOn ?? [];
    expect(deps).toContain("composables/useUserApi.ts");
    expect(deps).toContain("components/base/Button.vue");
  });

  it("excludes self-dependency", () => {
    for (const f of files) {
      expect(f.dependsOn).not.toContain(f.id);
    }
  });

  it("sorts dependsOn ascending", () => {
    for (const f of files) {
      expect(f.dependsOn).toEqual([...f.dependsOn].sort());
    }
  });
});

describe("buildCallGraph — visits each node once (cycle safety, Req 2.1)", () => {
  it("produces no duplicate FunctionNode ids even with mutual recursion", () => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    const perFile = extractPerFile(project, fileMap, collector);
    const functions = buildCallGraph(perFile, fileMap, project);
    const ids = functions.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dedupes repeated edges in calls", () => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    const perFile = extractPerFile(project, fileMap, collector);
    const functions = buildCallGraph(perFile, fileMap, project);
    for (const f of functions) {
      expect(new Set(f.calls).size).toBe(f.calls.length);
    }
  });
});

describe("buildCallGraph — skipped (syntax-error) files are excluded (Req 4.1)", () => {
  it("does not create nodes for useBroken.ts (skipped at fileMap)", () => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    const fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
    const perFile = extractPerFile(project, fileMap, collector);
    const functions = buildCallGraph(perFile, fileMap, project);
    expect(functions.some((f) => f.file === "composables/useBroken.ts")).toBe(false);
    // BrokenWidget.vue (SFC error) is skipped too.
    expect(functions.some((f) => f.file === "components/BrokenWidget.vue")).toBe(false);
  });
});

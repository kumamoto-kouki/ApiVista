import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFileMap, resolveSpecifierToFileId, type FileMap } from "../fileMap.js";
import { buildProject } from "../project.js";
import { WarningCollector } from "../warnings.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** 一時 frontendRoot を作り、相対 POSIX パス → 内容のマップでファイルを配置する。 */
function makeFrontendRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fce-filemap-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("buildFileMap (Pass0) — real sample_nuxt fixture", () => {
  let fileMap: FileMap;
  let collector: WarningCollector;

  beforeEach(() => {
    collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
  });

  it("indexes only frontend files that parsed successfully (Req 5.1)", () => {
    // 健全なファイルは含まれ、構文/SFC エラーは Pass0 で skip 済み。
    expect(fileMap.fileIds.has("composables/useUserApi.ts")).toBe(true);
    expect(fileMap.fileIds.has("components/UserList.vue")).toBe(true);
    expect(fileMap.fileIds.has("composables/useBroken.ts")).toBe(false);
    expect(fileMap.fileIds.has("components/BrokenWidget.vue")).toBe(false);
  });

  it("indexes exported composable/function names in exportIndex (auto-import)", () => {
    const fetchUsers = fileMap.exportIndex.get("fetchUsers");
    const createUser = fileMap.exportIndex.get("createUser");
    expect(fetchUsers).toBeDefined();
    expect(createUser).toBeDefined();
    expect(fetchUsers?.[0].fileId).toBe("composables/useUserApi.ts");
    expect(fetchUsers?.[0].functionId).toBe("composables/useUserApi:fetchUsers");
    expect(createUser?.[0].functionId).toBe("composables/useUserApi:createUser");
  });

  it("indexes components by Nuxt directory-prefixed PascalCase names (Issue 2)", () => {
    // components/UserList.vue -> UserList
    const userList = fileMap.componentIndex.get("UserList");
    expect(userList).toBeDefined();
    expect(userList?.[0].fileId).toBe("components/UserList.vue");
    expect(userList?.[0].functionId).toBe("components/UserList:UserList");

    // components/base/Button.vue -> BaseButton (directory prefix `base`)
    const baseButton = fileMap.componentIndex.get("BaseButton");
    expect(baseButton).toBeDefined();
    expect(baseButton?.[0].fileId).toBe("components/base/Button.vue");
    expect(baseButton?.[0].functionId).toBe("components/base/Button:BaseButton");
  });

  it("indexes non-components .vue by plain filename PascalCase (pages/users.vue -> Users)", () => {
    const users = fileMap.componentIndex.get("Users");
    expect(users).toBeDefined();
    expect(users?.[0].fileId).toBe("pages/users.vue");
    expect(users?.[0].functionId).toBe("pages/users:Users");
  });

  it("does not index syntax-error / SFC-error files and does not double-record warnings", () => {
    // 構文/SFC エラーは buildProject/extractSfc が既に1件ずつ記録済み。
    // buildFileMap は同じ対象を二重記録しない。
    const broken = collector.warnings.filter((w) => w.target === "composables/useBroken.ts");
    const brokenVue = collector.warnings.filter((w) => w.target === "components/BrokenWidget.vue");
    expect(broken).toHaveLength(1);
    expect(brokenVue).toHaveLength(1);
  });
});

describe("resolveSpecifierToFileId — real sample_nuxt fixture", () => {
  let fileMap: FileMap;

  beforeEach(() => {
    const collector = new WarningCollector();
    const project = buildProject(SAMPLE_NUXT, collector);
    fileMap = buildFileMap(SAMPLE_NUXT, project, collector);
  });

  it("resolves `~/` alias specifier to a frontendRoot-relative fileId", () => {
    const resolved = resolveSpecifierToFileId(
      "~/composables/useUserApi",
      "composables/useReport.ts",
      fileMap,
    );
    expect(resolved).toBe("composables/useUserApi.ts");
  });

  it("resolves `@/` alias specifier to a frontendRoot-relative fileId", () => {
    const resolved = resolveSpecifierToFileId(
      "@/composables/useUserApi",
      "composables/useReport.ts",
      fileMap,
    );
    expect(resolved).toBe("composables/useUserApi.ts");
  });

  it("returns null for an external (node_modules) specifier", () => {
    expect(resolveSpecifierToFileId("axios", "composables/useUserApi.ts", fileMap)).toBeNull();
    expect(resolveSpecifierToFileId("vue", "pages/users.vue", fileMap)).toBeNull();
  });
});

describe("resolveSpecifierToFileId — extension/index resolution (in-memory)", () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
  });

  function build(files: Record<string, string>): FileMap {
    const root = makeFrontendRoot(files);
    roots.push(root);
    const collector = new WarningCollector();
    const project = buildProject(root, collector);
    return buildFileMap(root, project, collector);
  }

  it("resolves a relative specifier with omitted extension to a .ts fileId", () => {
    const fileMap = build({
      "composables/useUserApi.ts": "export function fetchUsers() { return 1; }\n",
      "composables/useReport.ts": 'import { fetchUsers } from "./useUserApi";\n',
    });
    expect(resolveSpecifierToFileId("./useUserApi", "composables/useReport.ts", fileMap)).toBe(
      "composables/useUserApi.ts",
    );
  });

  it("resolves a relative `../` specifier across directories", () => {
    const fileMap = build({
      "lib/api.ts": "export const api = 1;\n",
      "pages/users.vue": [
        "<script setup>",
        'import { api } from "../lib/api";',
        "</script>",
        "",
      ].join("\n"),
    });
    expect(resolveSpecifierToFileId("../lib/api", "pages/users.vue", fileMap)).toBe("lib/api.ts");
  });

  it("resolves a specifier to a directory index file (index.ts)", () => {
    const fileMap = build({
      "lib/index.ts": "export const x = 1;\n",
      "app.ts": 'import { x } from "./lib";\n',
    });
    expect(resolveSpecifierToFileId("./lib", "app.ts", fileMap)).toBe("lib/index.ts");
  });

  it("resolves a `.vue` specifier with omitted extension", () => {
    const fileMap = build({
      "components/UserList.vue": ["<script setup>", "const n = 1;", "</script>", ""].join("\n"),
      "pages/users.vue": [
        "<script setup>",
        'import UserList from "../components/UserList";',
        "</script>",
        "",
      ].join("\n"),
    });
    expect(resolveSpecifierToFileId("../components/UserList", "pages/users.vue", fileMap)).toBe(
      "components/UserList.vue",
    );
  });

  it("returns null when the resolved path is outside the indexed frontend files", () => {
    const fileMap = build({ "app.ts": 'import x from "./missing";\n' });
    expect(resolveSpecifierToFileId("./missing", "app.ts", fileMap)).toBeNull();
  });

  it("indexes default-exported and named arrow-function exports in exportIndex", () => {
    const fileMap = build({
      "utils/helpers.ts":
        "export const doThing = () => 1;\nexport function other() { return 2; }\n",
    });
    expect(fileMap.exportIndex.get("doThing")?.[0].functionId).toBe("utils/helpers:doThing");
    expect(fileMap.exportIndex.get("other")?.[0].functionId).toBe("utils/helpers:other");
  });

  it("dedups redundant directory segments in component names (components/user/List.vue -> UserList)", () => {
    const fileMap = build({
      "components/user/List.vue": ["<script setup>", "const n = 1;", "</script>", ""].join("\n"),
    });
    expect(fileMap.componentIndex.get("UserList")?.[0].fileId).toBe("components/user/List.vue");
  });
});

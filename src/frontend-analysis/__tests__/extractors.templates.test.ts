import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractTemplateRefs, type TemplateRefEdge } from "../extractors/templates.js";
import { componentNameFromFileId } from "../fileMap.js";
import { makeFunctionId } from "../ids.js";

/** リポジトリ内の実フィクスチャ sample_nuxt の絶対パス。 */
const SAMPLE_NUXT = resolve(__dirname, "../../../tests/fixtures/sample_nuxt");

/** 黙する警告コレクター（本タスクの検証は SFC エラー無しケースが中心）。 */
const silentCollector = {
  record: (): void => {},
  recordParseError: (): void => {},
};

/** sample_nuxt の `.vue` 生ソースを fileId から読む。 */
function readVue(fileId: string): string {
  return readFileSync(resolve(SAMPLE_NUXT, ...fileId.split("/")), "utf8");
}

/** 親→子名でエッジ候補を引く（順不同比較用）。 */
function findEdge(
  edges: TemplateRefEdge[],
  parentNodeId: string,
  childComponentName: string,
): TemplateRefEdge | undefined {
  return edges.find(
    (e) => e.parentNodeId === parentNodeId && e.childComponentName === childComponentName,
  );
}

describe("extractTemplateRefs — parent component node -> child component name edges (Req 2.1)", () => {
  it("extracts <UserList/> from pages/users.vue as a Users -> UserList edge candidate", () => {
    const fileId = "pages/users.vue";
    const edges = extractTemplateRefs(readVue(fileId), fileId, silentCollector);

    const parentId = makeFunctionId("pages/users", "Users");
    const edge = findEdge(edges, parentId, "UserList");
    expect(edge).toBeDefined();
    expect(edge?.parentComponentName).toBe("Users");
    expect(edge?.parentNodeId).toBe(parentId);
    expect(edge?.childComponentName).toBe("UserList");
    expect(edge?.location.file).toBe(fileId);
    // <UserList/> is on line 22 of the .vue source.
    expect(edge?.location.line).toBe(22);
  });

  it("extracts <BaseButton/> from components/UserList.vue as a UserList -> BaseButton edge candidate", () => {
    const fileId = "components/UserList.vue";
    const edges = extractTemplateRefs(readVue(fileId), fileId, silentCollector);

    const parentId = makeFunctionId("components/UserList", "UserList");
    const edge = findEdge(edges, parentId, "BaseButton");
    expect(edge).toBeDefined();
    expect(edge?.parentComponentName).toBe("UserList");
    // child name resolution to fileId/component node is 4.1's job; here we keep the name.
    expect(edge?.childComponentName).toBe("BaseButton");
  });

  it("uses componentNameFromFileId for the parent node name (consistent with 3.2/fileMap)", () => {
    const fileId = "pages/users.vue";
    const edges = extractTemplateRefs(readVue(fileId), fileId, silentCollector);
    const expectedParent = componentNameFromFileId(fileId);

    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.parentComponentName).toBe(expectedParent);
    }
  });

  it("excludes dynamic <component :is> references (not statically resolvable)", () => {
    const source = [
      '<script setup lang="ts">',
      "const current = 'UserList'",
      "</script>",
      "",
      "<template>",
      "  <div>",
      '    <component :is="current" />',
      "    <StaticChild />",
      "  </div>",
      "</template>",
    ].join("\n");

    const edges = extractTemplateRefs(source, "pages/dynamic.vue", silentCollector);

    expect(
      findEdge(edges, makeFunctionId("pages/dynamic", "Dynamic"), "StaticChild"),
    ).toBeDefined();
    // The dynamic <component :is> must not produce an edge candidate.
    expect(edges.some((e) => e.childComponentName === "Component")).toBe(false);
    expect(edges.some((e) => e.childComponentName === "")).toBe(false);
  });

  it("normalizes kebab-case child tags to PascalCase (via extractSfc)", () => {
    const source = [
      '<script setup lang="ts"></script>',
      "<template>",
      "  <user-list />",
      "</template>",
    ].join("\n");

    const edges = extractTemplateRefs(source, "pages/list.vue", silentCollector);
    expect(findEdge(edges, makeFunctionId("pages/list", "List"), "UserList")).toBeDefined();
  });

  it("returns no edges for a .vue without component references", () => {
    const source = [
      '<script setup lang="ts"></script>',
      "<template>",
      "  <div><span>plain html only</span></div>",
      "</template>",
    ].join("\n");

    const edges = extractTemplateRefs(source, "pages/plain.vue", silentCollector);
    expect(edges).toHaveLength(0);
  });

  it("returns no edges when the SFC fails to parse (extractSfc records the error)", () => {
    let recorded = 0;
    const collector = {
      record: (): void => {},
      recordParseError: (): void => {
        recorded += 1;
      },
    };
    // Unterminated template tag -> SFC parse error.
    const source = ["<template>", "  <UserList />"].join("\n");

    const edges = extractTemplateRefs(source, "pages/broken.vue", collector);
    expect(edges).toHaveLength(0);
    expect(recorded).toBe(1);
  });
});
